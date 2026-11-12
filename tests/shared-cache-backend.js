// An in-memory stand-in for the Vercel Runtime Cache, injected into
// api/_shared-cache.js with __setSharedCacheBackendForTests. Values are
// JSON round-tripped on the way in and out, as the real store does, so a
// test can never pass by sharing an object reference. Every read and write
// is logged. Reset the injection in afterEach: the seam is module state,
// shared by every test file in the run.
export function memoryBackend() {
    const store = new Map();
    const reads = [];
    const writes = [];
    return {
        store,
        reads,
        writes,
        seed(key, value) { store.set(key, JSON.stringify(value)); },
        peek(key) { return store.has(key) ? JSON.parse(store.get(key)) : undefined; },
        async get(key) {
            reads.push(key);
            return store.has(key) ? JSON.parse(store.get(key)) : null;
        },
        async set(key, value, options) {
            writes.push({ key, options });
            store.set(key, JSON.stringify(value));
        },
    };
}

// Records every global fetch and fails it, for asserting that a page render
// makes no HTTP call (to its own /api/ or anywhere else). Returns the call
// log and a restore function.
export function recordFetches() {
    const saved = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        throw new Error(`unexpected fetch: ${url}`);
    };
    return { calls, restore: () => { globalThis.fetch = saved; } };
}
