// Durable per-issuance snapshots — the piece that lets edition permalinks
// outlive NWS's ~7-day product retention. Entirely optional: everything here
// no-ops unless Vercel Blob is provisioned (BLOB_READ_WRITE_TOKEN present in
// the environment). Provisioning = Vercel dashboard → Storage → Blob, then
// `bun install` picks up @vercel/blob from package.json.
let blobModPromise = null;

async function blob() {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
    if (!blobModPromise) {
        blobModPromise = import('@vercel/blob').catch(() => null);
    }
    return blobModPromise;
}

const keyFor = (office, id) => `plaincast/issuances/${office}/${id}.json`;

export async function getSnapshot(office, id) {
    const b = await blob();
    if (!b) return null;
    try {
        const head = await b.head(keyFor(office, id));
        if (!head?.url) return null;
        const res = await fetch(head.url, { signal: AbortSignal.timeout(5000) });
        return res.ok ? await res.json() : null;
    } catch {
        return null; // absent, expired token, or network — all mean "no snapshot"
    }
}

export async function putSnapshot(office, id, payload) {
    const b = await blob();
    if (!b) return false;
    try {
        await b.put(keyFor(office, id), JSON.stringify(payload), {
            access: 'public',
            addRandomSuffix: false,
            contentType: 'application/json',
        });
        return true;
    } catch (e) {
        console.warn('Snapshot write failed:', e?.message);
        return false;
    }
}
