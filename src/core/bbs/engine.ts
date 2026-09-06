import { BBSOutput, BarDef, DataFact, MemberDef, BBSEngineResult, BBSBuildManifest, BBSRowFactDep, BBSLifecycleStatus } from './schemas';

// Note: DrawingMemory here is a placeholder for the structured memory parsed from the drawing
export interface DrawingMemory {
    drawingHash?: string;
    // A structured representation of the drawing
    // e.g., sections, tables, callouts, notes
    rawFacts: Array<DataFact<any>>;
    membersInfo: Array<{
        memberType: DataFact<string>;
        memberMark: DataFact<string>;
        numberOfMembers: DataFact<number>;
        dimensions: Record<string, DataFact<number>>;
        cover: Record<string, DataFact<number>>;
        barsInfo: Array<any>;
    }>;
}

export function runValidation(output: BBSOutput, manifest: BBSBuildManifest): BBSBuildManifest {
    let hasAssumptions = false;
    let hasMissing = false;

    for (const group of output.members) {
        if (group.member.numberOfMembers.status === 'MISSING' || group.member.numberOfMembers.value === null) {
            hasMissing = true;
        }
        for (const bar of group.bars) {
            if (bar.coverAssumption === 'TO_BE_VERIFIED' || bar.coverAssumption === 'ASSUMED') {
                hasAssumptions = true;
            }
            if (bar.cuttingLength === 'MISSING' || bar.totalQuantity === 'MISSING' || bar.totalWeight === 'MISSING') {
                hasMissing = true;
            }
        }
    }

    if (hasAssumptions || hasMissing) {
        manifest.status = 'VALIDATED';
    } else {
        manifest.status = 'FINAL';
    }
    manifest.validatedAt = Date.now();
    return manifest;
}

export class GenericBBSEngine {
    
    public async process(drawingMemory: DrawingMemory): Promise<BBSEngineResult & BBSOutput> {
        this.validateInput(drawingMemory);
        
        const output: BBSOutput = {
            members: [],
            totalProjectWeight: 0
        };

        const drawingHash = drawingMemory.drawingHash ?? 'synthetic-drawing-hash';
        const allFactIds: string[] = [];
        const factVersions: Record<string, number> = {};
        const rowDeps: BBSRowFactDep[] = [];

        const recordFact = (fact?: DataFact<any>): string | null => {
            if (!fact || !fact.id) return null;
            if (!allFactIds.includes(fact.id)) {
                allFactIds.push(fact.id);
            }
            factVersions[fact.id] = fact.ledgerSeq ?? 0;
            return fact.id;
        };

        // Record any rawFacts
        for (const rf of drawingMemory.rawFacts) {
            recordFact(rf);
        }

        let isProjectWeightMissing = false;

        for (const memberInfo of drawingMemory.membersInfo) {
            this.assertFactPresent(memberInfo.memberType, 'memberType');
            this.assertFactPresent(memberInfo.memberMark, 'memberMark');
            this.assertFactPresent(memberInfo.numberOfMembers, 'numberOfMembers');

            const memberFactIds: string[] = [];
            const mTypeFact = recordFact(memberInfo.memberType); if (mTypeFact) memberFactIds.push(mTypeFact);
            const mMarkFact = recordFact(memberInfo.memberMark); if (mMarkFact) memberFactIds.push(mMarkFact);
            const mCountFact = recordFact(memberInfo.numberOfMembers); if (mCountFact) memberFactIds.push(mCountFact);
            for (const dimFact of Object.values(memberInfo.dimensions)) {
                const fId = recordFact(dimFact); if (fId) memberFactIds.push(fId);
            }
            for (const covFact of Object.values(memberInfo.cover)) {
                const fId = recordFact(covFact); if (fId) memberFactIds.push(fId);
            }
            
            const member: MemberDef = {
                memberType: memberInfo.memberType,
                memberMark: memberInfo.memberMark,
                numberOfMembers: memberInfo.numberOfMembers,
                dimensions: memberInfo.dimensions,
                cover: memberInfo.cover
            };

            const processedBars: BarDef[] = [];
            
            for (const barInfo of memberInfo.barsInfo) {
                // Here we would map barInfo to BarDef
                // For this generic engine we will simulate processing a fully constructed BarDef
                // In reality, this would use grammar parsers to extract from `rawFacts`
                const bar: BarDef = barInfo as BarDef;
                
                this.assertFactPresent(bar.barMark, 'barMark');
                this.assertFactPresent(bar.diameter, 'diameter');

                const barFactIds = [...memberFactIds];
                const bMarkId = recordFact(bar.barMark); if (bMarkId) barFactIds.push(bMarkId);
                const bDiaId = recordFact(bar.diameter); if (bDiaId) barFactIds.push(bDiaId);
                if (bar.quantityPerMember) {
                    const qId = recordFact(bar.quantityPerMember); if (qId) barFactIds.push(qId);
                }
                if (bar.spacing?.uniformSpacing) {
                    const sId = recordFact(bar.spacing.uniformSpacing); if (sId) barFactIds.push(sId);
                }
                if (bar.shape?.straightSegments) {
                    for (const seg of bar.shape.straightSegments) {
                        const sId = recordFact(seg); if (sId) barFactIds.push(sId);
                    }
                }
                if (bar.shape?.legs) {
                    for (const leg of bar.shape.legs) {
                        const lId = recordFact(leg); if (lId) barFactIds.push(lId);
                    }
                }
                if (bar.shape?.bends) {
                    for (const b of bar.shape.bends) {
                        const aId = recordFact(b.angle); if (aId) barFactIds.push(aId);
                        const dId = recordFact(b.deduction); if (dId) barFactIds.push(dId);
                    }
                }
                
                this.calculateBar(bar, member);
                
                processedBars.push(bar);

                const rowId = `${member.memberMark.value ?? 'unknown'}:${bar.barMark.value ?? 'unknown'}`;
                rowDeps.push({
                    rowId,
                    factIds: barFactIds,
                    drawingHash
                });
            }
            
            output.members.push({
                member,
                bars: processedBars
            });
            
            // Calculate total weight if all bars have it
            let memberTotalWeight = 0;
            let isMemberWeightMissing = false;
            for (const bar of processedBars) {
                if (bar.totalWeight === 'MISSING' || typeof bar.totalWeight !== 'number') {
                    isMemberWeightMissing = true;
                    break;
                }
                memberTotalWeight += bar.totalWeight;
            }
            
            if (isMemberWeightMissing) {
                isProjectWeightMissing = true;
            } else {
                if (typeof output.totalProjectWeight === 'number') {
                    output.totalProjectWeight += memberTotalWeight;
                }
            }
        }
        
        if (isProjectWeightMissing) {
            output.totalProjectWeight = 'MISSING';
        }
        
        const manifest: BBSBuildManifest = {
            buildId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `build-${Date.now()}`,
            builtAt: Date.now(),
            drawingHash,
            factIds: Array.from(new Set(allFactIds)),
            factVersions: Object.assign({}, factVersions),
            rowDeps,
            status: 'VALIDATED'
        };

        runValidation(output, manifest);

        return {
            output,
            manifest,
            members: output.members,
            totalProjectWeight: output.totalProjectWeight
        };
    }

    private validateInput(memory: DrawingMemory) {
        // Validation Gate: Ensure all necessary DataFacts are DRAWING_READ, DERIVED from other facts, or USER_INPUT
        // Throw or block if any required fact is MISSING or UNREADABLE and cannot be resolved without user input.
        for (const fact of memory.rawFacts) {
            if (fact.status === 'MISSING' || fact.status === 'UNREADABLE') {
                throw new Error(`Mandatory input fact is missing or unreadable: ${fact.semanticType}. Needs user input.`);
            }
        }
    }
    
    private assertFactPresent(fact: DataFact<any> | undefined, fieldName: string) {
        if (!fact || fact.status === 'MISSING' || fact.status === 'UNREADABLE' || fact.value === null) {
            throw new Error(`Missing required design input for: ${fieldName}. Please resolve via User Input.`);
        }
    }

    private calculateBar(bar: BarDef, member: MemberDef) {
        // 1. Calculate Quantity
        let quantity = 0;
        if (bar.quantityPerMember && typeof bar.quantityPerMember.value === 'number') {
            quantity = bar.quantityPerMember.value;
        } else if (bar.spacing && bar.spacing.uniformSpacing && typeof bar.spacing.uniformSpacing.value === 'number') {
            // Need a dimension to spread across
            // In a fully generic engine, we'd need to know *which* dimension to spread across.
            // For now, if we can't derive it, we mark as MISSING.
            bar.totalQuantity = 'MISSING';
            bar.cuttingLength = 'MISSING';
            bar.totalLength = 'MISSING';
            bar.unitWeight = 'MISSING';
            bar.totalWeight = 'MISSING';
            return;
        } else {
            bar.totalQuantity = 'MISSING';
        }

        if (quantity > 0 && typeof member.numberOfMembers.value === 'number') {
            bar.totalQuantity = quantity * member.numberOfMembers.value;
        } else {
            bar.totalQuantity = 'MISSING';
        }
        
        // 2. Calculate Cutting Length
        let cuttingLength = 0;
        let isLengthMissing = false;
        
        // Sum straight segments
        for (const seg of bar.shape.straightSegments) {
            if (typeof seg.value === 'number') {
                cuttingLength += seg.value;
            } else {
                isLengthMissing = true;
            }
        }
        
        // Sum legs
        for (const leg of bar.shape.legs) {
            if (typeof leg.value === 'number') {
                cuttingLength += leg.value;
            } else {
                isLengthMissing = true;
            }
        }
        
        // Deduct bends
        for (const bend of bar.shape.bends) {
            if (typeof bend.deduction.value === 'number') {
                cuttingLength -= bend.deduction.value;
            } else {
                isLengthMissing = true;
            }
        }
        
        // Add hooks
        if (bar.shape.hooks.start && typeof bar.shape.hooks.start.length.value === 'number') {
            cuttingLength += bar.shape.hooks.start.length.value;
        } else if (bar.shape.hooks.start) {
            isLengthMissing = true;
        }
        
        if (bar.shape.hooks.end && typeof bar.shape.hooks.end.length.value === 'number') {
            cuttingLength += bar.shape.hooks.end.length.value;
        } else if (bar.shape.hooks.end) {
            isLengthMissing = true;
        }

        if (isLengthMissing || cuttingLength <= 0) {
            bar.cuttingLength = 'MISSING';
        } else {
            bar.cuttingLength = cuttingLength;
        }

        // 3. Calculate Total Length
        if (typeof bar.totalQuantity === 'number' && typeof bar.cuttingLength === 'number') {
            bar.totalLength = (bar.totalQuantity * bar.cuttingLength) / 1000; // Assuming mm to m conversion
        } else {
            bar.totalLength = 'MISSING';
        }
        
        // 4. Calculate Weight
        if (typeof bar.diameter.value === 'number') {
            const d = bar.diameter.value;
            bar.unitWeight = (d * d) / 162; // kg/m
        } else {
            bar.unitWeight = 'MISSING';
        }
        
        if (typeof bar.totalLength === 'number' && typeof bar.unitWeight === 'number') {
            bar.totalWeight = bar.totalLength * bar.unitWeight;
        } else {
            bar.totalWeight = 'MISSING';
        }
    }
}
