import { createHash } from 'crypto';
import type { TokenRequestLog } from '../types';

export interface HourSource {
    hour: string;
    version: string;
    modifiedTime: number;
}
export interface HourRecordSource extends HourSource {
    records: ReadonlyMap<string, TokenRequestLog>;
}

export class HourlyMembership {
    private readonly bits = new Uint8Array(128 * 1024);

    static positions(id: string): number[] {
        const hash = createHash('sha256').update(id).digest();
        return Array.from({ length: 7 }, (_, index) => hash.readUInt32LE(index * 4) & 0xfffff);
    }

    constructor(ids: Iterable<string>) {
        for (const id of ids) {
            for (const position of HourlyMembership.positions(id)) {
                this.bits[position >>> 3] |= 1 << (position & 7);
            }
        }
    }

    mayContain(positions: readonly number[]): boolean {
        return positions.every(position => (this.bits[position >>> 3] & (1 << (position & 7))) !== 0);
    }
}
