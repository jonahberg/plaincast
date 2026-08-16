// Progressive enhancement for the National Desk. The SSR page (api/national-desk.js
// + api/_national-shell.html) is complete without any of this — masthead,
// deterministic deck, wire, census, and the office index all render server-side.
// Everything here is a bonus on top of that floor, so every failure path is
// silence: never an error state, never console noise in normal operation.
// Untested DOM glue, same treatment as /js/theme-init.js.

// Today's date in the masthead folio (the shell can't bake a date — it's CDN-cached).
try {
    const folio = document.getElementById('folio-date');
    if (folio) {
        folio.textContent = new Date().toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
} catch { /* silence */ }

// AI-polished deck: swap the regex-translated SSR deck (#desk-deck) for the
// model's plain-English rewrite once it arrives. api/national-lede is always
// 200 in normal operation — {deck, issued, cached} on success, or
// {deck: null, transient: true} when there is nothing to say yet — so only a
// truthy `deck` swaps the text; the SSR deck stays otherwise.
fetch('/api/national-lede')
    .then(r => (r.status === 200 ? r.json() : null))
    .then(data => {
        const deck = document.getElementById('desk-deck');
        if (deck && data?.deck) {
            deck.textContent = data.deck;
            const attrib = document.querySelector('.desk-attrib');
            if (attrib && !/Simplified by AI/.test(attrib.textContent)) {
                attrib.textContent += ' Simplified by AI.';
            }
        }
    })
    .catch(() => {});

// Your Local Desk — geo pointer from the uncached endpoint. api/whereami
// answers 200 with {office, city} when it can resolve a reader's office, or
// 204 with no body otherwise (nothing to parse there — don't call r.json()).
fetch('/api/whereami')
    .then(r => (r.status === 200 ? r.json() : null))
    .then(data => {
        const slot = document.getElementById('local-desk');
        if (!slot || !data?.office || !data?.city) return;
        const a = document.createElement('a');
        a.href = `/o/${data.office}/`;
        a.textContent = `${data.city} (${data.office})`;
        slot.textContent = 'Your local desk: ';
        slot.append(a, ' →');
        slot.hidden = false;
    })
    .catch(() => {});
