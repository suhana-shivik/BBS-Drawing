// R1 — the studio project registry.
//
// Projects persist in the existing STORE_PROJECTS object store (cad/store.ts)
// as ProjectData rows; this module is the studio-shaped view over them plus
// the graceful in-memory fallback every other store in this codebase has:
// when IndexedDB is unavailable (private window, jsdom) a created project
// still exists for the session, exactly like the in-memory register.
//
// There is NO default project. Nothing here ever invents or falls back to a
// project id — a caller that needs one takes it as an argument (§1.2).

import { useEffect, useSyncExternalStore } from 'react';
import * as repo from '../cad/store';
import * as remote from '../data/projects';
import { isSupabaseConfigured } from '../lib/supabase';
import type { ProjectData } from '../core/types';
import { newId } from '../register/id';
import { loadLedgerIdb } from '../facts/store';
import { missingFacts } from '../facts/ledger';
import type { StudioStore } from './store';
import { loadBoot } from './store';

export interface StudioProject {
  id: string;
  name: string;
  client?: string;
  projectNumber?: string;
  archived?: boolean;
  createdAt: number;
  modifiedAt: number;
}

/** What a project card summarises — read from stored data, never recomputed. */
export interface ProjectCardSummary {
  /** current drawings on the register (PDF pages not counted) */
  drawings: number | null;
  /** net steel of the latest filed BBS artifact, in tonnes; null = not on file */
  tonnageT: number | null;
  /** MISSING facts in the project ledger; null = no ledger on file */
  openQuestions: number | null;
}

// ------------------------------------------------------------
// in-memory mirror + subscription
// ------------------------------------------------------------

const memProjects = new Map<string, StudioProject>();
let listed: StudioProject[] | null = null;
let loading = false;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

function merged(): StudioProject[] {
  const byId = new Map<string, StudioProject>();
  for (const p of listed ?? []) byId.set(p.id, p);
  for (const p of memProjects.values()) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function toProjectData(p: StudioProject): ProjectData {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    modifiedAt: p.modifiedAt,
    levels: [],
    elements: [],
    settings: { unit: 'mm', gridSpacing: 100, snapGrid: true, snapObjects: true },
    ...(p.client !== undefined ? { client: p.client } : {}),
    ...(p.projectNumber !== undefined ? { projectNumber: p.projectNumber } : {}),
    ...(p.archived !== undefined ? { archived: p.archived } : {}),
  };
}

// ------------------------------------------------------------
// listing (with the one-time legacy migration)
// ------------------------------------------------------------

let migrated = false;

/**
 * Data written before projects existed lives under the id 'studio' (register,
 * documents, artifacts) with no project record. If such a register exists and
 * no record names it, file one — otherwise that work would be unreachable
 * from the Projects home.
 */
async function migrateLegacyStudioProject(existing: StudioProject[]): Promise<void> {
  if (migrated) return;
  migrated = true;
  if (existing.some((p) => p.id === 'studio')) return;
  try {
    const register = await repo.getDrawingRegister('studio');
    if (!register || register.entries.length === 0) return;
    const now = Date.now();
    const legacy: StudioProject = {
      id: 'studio',
      name: 'Drawing Register',
      createdAt: register.updatedAt || now,
      modifiedAt: register.updatedAt || now,
    };
    await repo.putProject(toProjectData(legacy));
    memProjects.set(legacy.id, legacy);
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}

// ------------------------------------------------------------
// where projects actually live
// ------------------------------------------------------------
//
// With Supabase configured, the database IS the list: it is what makes a
// project belong to an account and what stops one account seeing another's.
// Without it — the demo path, unit tests, a checkout with no `.env` — the
// original IndexedDB behaviour stands, so nothing about the studio has to
// know which of the two it is talking to.
const remoteBacked = (): boolean => isSupabaseConfigured();

/** The last failure from the backing store, for the UI to show rather than an empty list. */
let lastError: string | null = null;

export async function listStudioProjects(): Promise<StudioProject[]> {
  if (remoteBacked()) {
    try {
      listed = await remote.listProjects();
      lastError = null;
    } catch (err) {
      // An error here is NOT an empty project list. A schema that has not been
      // installed, or an expired session, would otherwise look exactly like a
      // new account with no work in it — and the person would start again.
      lastError = err instanceof Error ? err.message : String(err);
      listed = [];
    }
    emit();
    return merged();
  }

  try {
    const metas = await repo.listProjects();
    listed = metas.map((m) => ({
      id: m.id,
      name: m.name,
      client: m.client,
      projectNumber: m.projectNumber,
      archived: m.archived,
      createdAt: m.createdAt,
      modifiedAt: m.modifiedAt,
    }));
    lastError = null;
  } catch {
    listed = [];
  }
  await migrateLegacyStudioProject(merged());
  emit();
  return merged();
}

export interface NewProjectInput {
  name: string;
  client?: string;
  projectNumber?: string;
}

export async function createStudioProject(input: NewProjectInput): Promise<StudioProject> {
  if (remoteBacked()) {
    // The database assigns the id. Everything filed under a project — its
    // register, facts and schedules — keys off that id, so it has to be the
    // one the server will recognise rather than a local one invented first.
    const project = await remote.createProject(input);
    memProjects.set(project.id, project);
    lastError = null;
    emit();
    return project;
  }

  const now = Date.now();
  const project: StudioProject = {
    id: newId('proj'),
    name: input.name.trim(),
    ...(input.client?.trim() ? { client: input.client.trim() } : {}),
    ...(input.projectNumber?.trim() ? { projectNumber: input.projectNumber.trim() } : {}),
    createdAt: now,
    modifiedAt: now,
  };
  memProjects.set(project.id, project);
  try {
    await repo.putProject(toProjectData(project));
  } catch {
    /* storage unavailable — the project lives for this session, like the register */
  }
  emit();
  return project;
}

export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const current = merged().find((p) => p.id === id);
  if (!current) return;
  const next: StudioProject = { ...current, archived, modifiedAt: Date.now() };
  memProjects.set(id, next);

  if (remoteBacked()) {
    try {
      const saved = await remote.updateProject(id, { archived });
      memProjects.set(id, saved);
    } catch (err) {
      // Put the row back as it was: a flag that looks changed on screen and is
      // not changed in the database is worse than a refusal.
      memProjects.set(id, current);
      lastError = err instanceof Error ? err.message : String(err);
    }
    emit();
    return;
  }

  try {
    // Preserve any BIM payload an older record may carry.
    const saved = await repo.getProject(id);
    await repo.putProject(saved ? { ...saved, archived, modifiedAt: next.modifiedAt } : toProjectData(next));
  } catch {
    /* storage unavailable — the archive flag holds for this session */
  }
  emit();
}

export function useStudioProjects(): { projects: StudioProject[]; loaded: boolean; error: string | null } {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  useEffect(() => {
    if (listed === null && !loading) {
      loading = true;
      void listStudioProjects().finally(() => {
        loading = false;
      });
    }
  }, []);
  return { projects: merged(), loaded: listed !== null, error: lastError };
}

/** tests only — forget everything, including the migration latch */
export function resetStudioProjectsForTest(): void {
  memProjects.clear();
  listed = null;
  loading = false;
  migrated = false;
  lastError = null;
  emit();
}

// ------------------------------------------------------------
// card summaries — read off stored artifacts/ledger, never computed (§1.3)
// ------------------------------------------------------------

interface StoredBbsResult {
  netWeightKg?: number;
}

export async function projectCardSummary(projectId: string): Promise<ProjectCardSummary> {
  let drawings: number | null = null;
  let tonnageT: number | null = null;
  let openQuestions: number | null = null;

  try {
    const register = await repo.getDrawingRegister(projectId);
    if (register) drawings = register.entries.filter((e) => e.revisionState !== 'superseded').length;
  } catch {
    /* omitted from the card rather than guessed */
  }

  try {
    const artifacts = await repo.getProjectArtifacts<{
      kind: string;
      mimeType: string;
      content: string;
      createdAt: number;
    }>(projectId);
    const latest = (artifacts ?? [])
      .filter((a) => a.kind === 'bbs' && a.mimeType === 'application/json')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) {
      const result = JSON.parse(latest.content) as StoredBbsResult;
      if (typeof result.netWeightKg === 'number') tonnageT = result.netWeightKg / 1000;
    }
  } catch {
    /* omitted rather than guessed */
  }

  try {
    const ledger = await loadLedgerIdb(projectId);
    if (ledger) openQuestions = missingFacts(ledger).length;
  } catch {
    /* omitted rather than guessed */
  }

  return { drawings, tonnageT, openQuestions };
}

// ------------------------------------------------------------
// recents (global, §1.4) + the one open gesture
// ------------------------------------------------------------

const RECENTS_KEY = 'studio.recentProjects.v1';
const RECENTS_MAX = 8;

export function recentProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function noteRecentProject(id: string): void {
  try {
    const next = [id, ...recentProjectIds().filter((r) => r !== id)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

/**
 * THE way a project is opened, everywhere (card, switcher, boot): notes the
 * recent, restores the project's last folder when it is the last project,
 * and hands the store the Files-first boot state.
 */
export function openProjectInStore(store: StudioStore, projectId: string): void {
  noteRecentProject(projectId);
  const boot = loadBoot();
  const folder = boot.lastProjectId === projectId ? boot.lastFolderPath : [];
  store.openProject(projectId, folder);
}
