// ─── ChST and SST on the server too (Nov 18 2026) ───────────────────
// Intl has no short name for Guam's or American Samoa's zone and prints an
// offset ("GMT+10", "GMT-11") where NWS writes ChST and SST. The client and
// the server pages already go through formatInZone
// (shadcn/src/lib/format.js); the RSS feed, the OG card, the National Desk
// and the model prompt's issuance and Zulu labels now do too, so there is one
// mapping.

import { describe, it, expect } from 'bun:test';
import { formatInZone, shortZoneName } from '../shadcn/src/lib/format.js';
import { formatIssuedLocal } from '../api/feed.js';
import { buildDateline } from '../api/og.js';
import { formatClock, formatExpiry } from '../api/_national.js';
import { annotateZuluTimes, getTranslationCalendarContext, sectionWrittenTime } from '../api/translate.js';

const AT = '2026-11-18T19:51:00+00:00'; // 5:51 AM ChST Thu (Guam), 8:51 AM SST Wed (Pago Pago)
const NO_OFFSET = /GMT[+-]\d/;

describe('shortZoneName: the name formatInZone prints', () => {
    it('ChST, SST, and Intl\'s own name elsewhere', () => {
        const d = new Date(AT);
        expect(shortZoneName(d, 'Pacific/Guam')).toBe('ChST');
        expect(shortZoneName(d, 'Pacific/Pago_Pago')).toBe('SST');
        expect(shortZoneName(d, 'America/Los_Angeles')).toBe('PST');
        expect(shortZoneName(d, 'Pacific/Honolulu')).toBe('HST');
        expect(formatInZone(d, { hour: 'numeric', timeZone: 'Pacific/Guam', timeZoneName: 'short' }).endsWith(' ChST')).toBe(true);
    });
});

describe('every server time label for GUM and PPG', () => {
    it('RSS item dates', () => {
        expect(formatIssuedLocal(new Date(AT), 'GUM')).toBe('Thu, Nov 19, 5:51 AM ChST');
        expect(formatIssuedLocal(new Date(AT), 'PPG')).toBe('Wed, Nov 18, 8:51 AM SST');
        expect(formatIssuedLocal(new Date(AT), 'LOX')).toBe('Wed, Nov 18, 11:51 AM PST');
    });

    it('OG card dateline', () => {
        expect(buildDateline(AT, 'GUM')).toBe('Area Forecast Discussion · Thu, Nov 19, 5:51 AM ChST');
        expect(buildDateline(AT, 'PPG')).toBe('Area Forecast Discussion · Wed, Nov 18, 8:51 AM SST');
    });

    it('National Desk clock and alert expiry', () => {
        expect(formatClock(AT, 'Pacific/Guam')).toBe('5:51 AM ChST');
        expect(formatClock(AT, 'Pacific/Pago_Pago')).toBe('8:51 AM SST');
        expect(formatClock(AT)).toBe('2:51 PM EST');
        expect(formatExpiry(AT, 'Pacific/Guam')).toMatch(/^until 5:51\sAM ChST$/);
        expect(formatExpiry(AT, 'Pacific/Pago_Pago')).toMatch(/^until 8:51\sAM SST$/);
    });

    it('the model prompt: issuance time, Zulu annotations, a Zulu stamp\'s written time', () => {
        expect(getTranslationCalendarContext('GUM', AT).localIssueTime).toMatch(/5:51\sAM ChST$/);
        expect(getTranslationCalendarContext('PPG', AT).localIssueTime).toMatch(/8:51\sAM SST$/);
        expect(annotateZuluTimes('VFR through 00Z.', 'GUM', AT)).toBe('VFR through 00Z (10 AM ChST).');
        expect(annotateZuluTimes('VFR through 00Z.', 'PPG', AT)).toBe('VFR through 00Z (1 PM SST).');
        const written = sectionWrittenTime('18/1736Z. Trade winds continue.', 'GUM', AT);
        expect(written).toContain('ChST');
        expect(written).not.toMatch(NO_OFFSET);
    });
});
