import { useEffect, useState } from 'react';

// Code that only runs after an interaction (the shortcuts dialog, a toast)
// or on a secondary view (the changelog, the "What changed" diff) is a
// separate chunk, fetched when first needed — never on first load — or a
// moment early, when the pointer or focus reaches the control that needs it.
//
// onDemand(load) returns get(): the first call starts the import, later
// calls share it, and get.peek() is the module once it has arrived. A failed
// load is NOT remembered (React.lazy would rethrow it forever), so the next
// call tries again. The service worker serves /assets/* cache-first (the
// names are content-hashed, and install precaches this build's chunks), so a
// chunk loads offline; one the worker does not hold fails offline, and every
// caller treats that as "this extra is unavailable".
export function onDemand(load) {
    let promise = null;
    let mod = null;
    const get = () => {
        if (!promise) {
            promise = load().then(
                (m) => { mod = m; return m; },
                (e) => { promise = null; throw e; },
            );
        }
        return promise;
    };
    get.peek = () => mod;
    return get;
}

// The module from get() once `wanted` turns true, for rendering. Returns
// { mod, error, retry }: mod is null until it arrives (and on failure);
// retry() starts a fresh attempt.
export function useOnDemand(get, wanted) {
    const [state, setState] = useState(() => ({ mod: null, error: null, attempt: 0 }));
    // peek() as well: a module prefetched on intent renders in the same frame
    // it is wanted, with no fallback frame in between.
    const mod = state.mod || get.peek();
    const { attempt } = state;
    useEffect(() => {
        if (!wanted || mod) return undefined;
        let live = true;
        get().then(
            (m) => { if (live) setState(s => ({ ...s, mod: m, error: null })); },
            (e) => { if (live) setState(s => ({ ...s, error: e })); },
        );
        return () => { live = false; };
    }, [get, wanted, mod, attempt]);
    const retry = () => setState(s => ({ ...s, error: null, attempt: s.attempt + 1 }));
    return { mod, error: mod ? null : state.error, retry };
}
