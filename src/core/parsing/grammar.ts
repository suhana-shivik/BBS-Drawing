import { DataFact, FactStatus } from '../bbs/schemas';

// Generic parser rules that do NOT rely on specific P1 formats.
// These rules look for structural patterns (e.g. [Quantity] [DiameterSymbol] [Diameter] [Type])

export interface ParsedCallout {
    quantity?: DataFact<number>;
    diameter?: DataFact<number>;
    type?: DataFact<string>;
    spacing?: DataFact<number>;
    spacingZone?: DataFact<string>;
}

export class GenericGrammarParser {
    
    /**
     * Parses a generic bar callout.
     * Examples:
     * "20-DIA 16 VERTICAL BARS"
     * "10 - T 12 @ 150 c/c"
     * "16 Ø 20"
     */
    public parseBarCallout(text: string, contextId: string): ParsedCallout {
        const result: ParsedCallout = {};
        
        // 1. Try to extract Quantity
        // Looks for a leading number followed by a dash or space before a diameter symbol
        const quantityMatch = text.match(/^(\d+)\s*(?:-|x|nos)?\s*(?:DIA|T|Y|Ø|#)/i);
        if (quantityMatch && quantityMatch[1]) {
            result.quantity = this.createFact(
                parseInt(quantityMatch[1], 10),
                'quantity',
                'DRAWING_READ',
                contextId,
                quantityMatch[0]
            );
        }

        // 2. Try to extract Diameter
        // Looks for DIA, T, Y, Ø followed by a number
        const diameterMatch = text.match(/(?:DIA|T|Y|Ø|#)\s*(\d+)/i);
        if (diameterMatch && diameterMatch[1]) {
            result.diameter = this.createFact(
                parseInt(diameterMatch[1], 10),
                'diameter',
                'DRAWING_READ',
                contextId,
                diameterMatch[0]
            );
        }

        // 3. Try to extract Spacing
        // Looks for @, spacing, or c/c
        const spacingMatch = text.match(/@\s*(\d+)\s*(?:c\/c|mm)?/i);
        if (spacingMatch && spacingMatch[1]) {
            result.spacing = this.createFact(
                parseInt(spacingMatch[1], 10),
                'spacing',
                'DRAWING_READ',
                contextId,
                spacingMatch[0],
                'mm' // Need to confirm unit from context in a real engine
            );
        }

        return result;
    }

    /**
     * Parse a generic dimension like "250 mm" or "300x400"
     * NEVER interprets the meaning (spacing vs dimension vs embedment) based on unit alone.
     * The caller must assign the semantic meaning based on the drawing context.
     */
    public parseValueWithUnit(text: string, contextId: string, semanticType: string): DataFact<number> | null {
        const match = text.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
        if (match && match[1]) {
            return this.createFact(
                parseFloat(match[1]),
                semanticType,
                'DRAWING_READ',
                contextId,
                text,
                match[2] // Unit
            );
        }
        return null;
    }
    
    private createFact<T>(
        value: T, 
        semanticType: string, 
        status: FactStatus, 
        sourceSection: string, 
        sourceText: string, 
        unit?: string
    ): DataFact<T> {
        return {
            value,
            semanticType,
            status,
            confidence: 1.0,
            sourceSection,
            sourceText,
            unit
        };
    }
}
