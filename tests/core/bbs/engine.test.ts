import { describe, it, expect } from 'vitest';
import { GenericBBSEngine, DrawingMemory } from '../../../src/core/bbs/engine';
import { DataFact } from '../../../src/core/bbs/schemas';

describe('GenericBBSEngine', () => {
    
    it('throws if a mandatory fact is MISSING or UNREADABLE', async () => {
        const engine = new GenericBBSEngine();
        
        const memory: DrawingMemory = {
            rawFacts: [
                {
                    value: null,
                    semanticType: 'dimension',
                    status: 'MISSING'
                }
            ],
            membersInfo: []
        };
        
        await expect(engine.process(memory)).rejects.toThrow('Mandatory input fact is missing or unreadable');
    });

    it('computes correctly for a fully synthetic member and does not leak P1 defaults', async () => {
        // We create a completely different member than P1 (e.g. continuous footing "CF1")
        const engine = new GenericBBSEngine();
        
        const memberMark: DataFact<string> = { value: 'CF1', semanticType: 'memberMark', status: 'DRAWING_READ' };
        const memberType: DataFact<string> = { value: 'FOOTING', semanticType: 'memberType', status: 'DRAWING_READ' };
        const numberOfMembers: DataFact<number> = { value: 5, semanticType: 'numberOfMembers', status: 'USER_INPUT' }; // Example: User provided
        
        const memory: DrawingMemory = {
            rawFacts: [memberMark, memberType, numberOfMembers],
            membersInfo: [
                {
                    memberType,
                    memberMark,
                    numberOfMembers,
                    dimensions: {
                        length: { value: 10000, semanticType: 'dimension', status: 'DRAWING_READ' },
                        width: { value: 2000, semanticType: 'dimension', status: 'DRAWING_READ' },
                        depth: { value: 500, semanticType: 'dimension', status: 'DRAWING_READ' }
                    },
                    cover: {
                        top: { value: 50, semanticType: 'cover', status: 'DRAWING_READ' },
                        bottom: { value: 50, semanticType: 'cover', status: 'DRAWING_READ' },
                        sides: { value: 50, semanticType: 'cover', status: 'DRAWING_READ' }
                    },
                    barsInfo: [
                        {
                            barMark: { value: '01', semanticType: 'barMark', status: 'DRAWING_READ' },
                            diameter: { value: 20, semanticType: 'diameter', status: 'DRAWING_READ' },
                            quantityPerMember: { value: 12, semanticType: 'quantity', status: 'DRAWING_READ' },
                            shape: {
                                straightSegments: [{ value: 9800, semanticType: 'dimension', status: 'DERIVED' }], // 10000 - 2*cover
                                legs: [{ value: 400, semanticType: 'dimension', status: 'DERIVED' }], // 500 - 2*cover
                                bends: [{ angle: { value: 90, semanticType: 'angle', status: 'DERIVED' }, deduction: { value: 40, semanticType: 'deduction', status: 'DERIVED' } }],
                                hooks: {},
                                dimensions: {}
                            }
                        }
                    ]
                }
            ]
        };
        
        const result = await engine.process(memory);
        
        expect(result.members).toHaveLength(1);
        const member = result.members[0].member;
        expect(member.memberMark.value).toBe('CF1');
        expect(member.memberType.value).toBe('FOOTING');
        expect(member.numberOfMembers.value).toBe(5);
        
        const bar = result.members[0].bars[0];
        expect(bar.barMark.value).toBe('01');
        
        // Check calculation correctly ignores anything about P1 (e.g. 20 members, dia 16)
        expect(bar.totalQuantity).toBe(12 * 5); // 60
        expect(bar.cuttingLength).toBe(9800 + 400 - 40); // 10160
        expect(bar.totalLength).toBe((60 * 10160) / 1000); // 609.6 m
        expect(bar.unitWeight).toBeCloseTo((20 * 20) / 162); // 2.469
        
        if (typeof bar.unitWeight === 'number' && typeof bar.totalLength === 'number') {
            expect(bar.totalWeight).toBeCloseTo(bar.totalLength * bar.unitWeight);
        } else {
            throw new Error('Weight should be a number');
        }
    });

    it('marks length and weight as MISSING if required dimensions are missing', async () => {
        const engine = new GenericBBSEngine();
        
        const memory: DrawingMemory = {
            rawFacts: [],
            membersInfo: [
                {
                    memberType: { value: 'BEAM', semanticType: 'memberType', status: 'DRAWING_READ' },
                    memberMark: { value: 'B1', semanticType: 'memberMark', status: 'DRAWING_READ' },
                    numberOfMembers: { value: 1, semanticType: 'numberOfMembers', status: 'DRAWING_READ' },
                    dimensions: {},
                    cover: {},
                    barsInfo: [
                        {
                            barMark: { value: 'A', semanticType: 'barMark', status: 'DRAWING_READ' },
                            diameter: { value: 12, semanticType: 'diameter', status: 'DRAWING_READ' },
                            quantityPerMember: { value: 2, semanticType: 'quantity', status: 'DRAWING_READ' },
                            shape: {
                                straightSegments: [{ value: null, semanticType: 'dimension', status: 'MISSING' }], // Missing!
                                legs: [],
                                bends: [],
                                hooks: {},
                                dimensions: {}
                            }
                        }
                    ]
                }
            ]
        };
        
        const result = await engine.process(memory);
        const bar = result.members[0].bars[0];
        
        expect(bar.cuttingLength).toBe('MISSING');
        expect(bar.totalLength).toBe('MISSING');
        expect(bar.totalWeight).toBe('MISSING');
    });
});
