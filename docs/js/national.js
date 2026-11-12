// Progressive enhancement for the National Desk. The SSR page (api/national-desk.js
// + api/_national-shell.html) is complete without any of this — masthead,
// deck, running copy, wire, census, and the office index all render
// server-side. Everything here is a bonus on top of that floor, so every
// failure path is silence: never an error state, never console noise in
// normal operation. Untested DOM glue, same treatment as /js/theme-init.js and
// /js/site-chrome.js. Strings from the API only ever reach the page through
// textContent — never innerHTML.

// Today's date in the page-intro kicker (#folio-date) (the shell can't bake a date — it's CDN-cached).
try {
    const folio = document.getElementById('folio-date');
    if (folio) {
        folio.textContent = new Date().toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
} catch { /* silence */ }

// Clock times in the reader's own zone. The server prints US Eastern (it is
// CDN-cached and cannot know the reader); each <time data-local-time> carries
// its instant in `datetime`, so re-render it here: "12:23 AM EST" becomes
// "9:23 PM PST" in Los Angeles. Any failure leaves the server text alone.
function localClock(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return null;
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).formatToParts(d)) parts[p.type] = p.value;
    if (!parts.hour || !parts.minute || !parts.dayPeriod) return null;
    return `${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()}`
        + (parts.timeZoneName ? ` ${parts.timeZoneName}` : '');
}
for (const el of document.querySelectorAll('time[data-local-time]')) {
    try {
        const text = localClock(el.getAttribute('datetime'));
        if (text) el.textContent = text;
    } catch { /* keep the Eastern text */ }
}

// The AI text, when the server could not embed it. api/national-desk.js reads
// /api/national-lede itself and embeds the AI deck and plain-English copy when
// they are ready for the outlook it rendered, marking each with data-ai; this
// is the fallback for a page rendered before they were. The endpoint is
// always 200 in normal operation: {deck, copy, issued, cached}, or
// {deck: null, copy: null, transient: true} when there is nothing yet.
// Nothing is swapped in for an outlook other than the page's own
// (.desk-lede[data-issued]), and nothing the server embedded is touched.
const sameInstant = (a, b) => {
    const x = new Date(a).getTime();
    return Boolean(a && b) && !Number.isNaN(x) && x === new Date(b).getTime();
};

function creditAi() {
    const attrib = document.querySelector('.desk-attrib');
    // Append a text node: assigning textContent would flatten the <time>.
    if (attrib && !/Simplified by AI/.test(attrib.textContent)) attrib.append(' Simplified by AI.');
}

// The same structure the server renders with AI copy: the plain-English
// paragraphs in .desk-copy, and the forecasters' own words moved (not copied)
// into a closed <details class="desk-original"> directly beneath it.
function swapInCopy(section, paragraphs) {
    const originals = [...section.children]
        .filter(el => el.tagName === 'P' && !el.classList.contains('desk-copy-label'));
    if (originals.length === 0) return false;
    const details = document.createElement('details');
    details.className = 'desk-original';
    const summary = document.createElement('summary');
    summary.textContent = "Read the Storm Prediction Center's original discussion";
    const body = document.createElement('div');
    body.className = 'desk-original-body';
    body.append(...originals);
    details.append(summary, body);
    section.replaceChildren(...paragraphs.map(text => {
        const p = document.createElement('p');
        p.textContent = text;
        return p;
    }));
    section.setAttribute('data-ai', '');
    section.after(details);
    return true;
}

const pageIssued = document.querySelector('.desk-lede')?.getAttribute('data-issued');
const deckEl = document.getElementById('desk-deck');
// Only a discussion may be replaced by AI copy — never the summary that runs
// as copy on the fallback path.
const copyEl = document.querySelector('.desk-copy[data-source="discussion"]');
const wantDeck = Boolean(deckEl && !deckEl.hasAttribute('data-ai'));
const wantCopy = Boolean(copyEl && !copyEl.hasAttribute('data-ai'));

if (pageIssued && (wantDeck || wantCopy)) {
    fetch('/api/national-lede')
        .then(r => (r.status === 200 ? r.json() : null))
        .then(data => {
            if (!data || !sameInstant(data.issued, pageIssued)) return;
            let added = false;
            if (wantDeck && typeof data.deck === 'string' && data.deck.trim()) {
                deckEl.textContent = data.deck.trim();
                deckEl.setAttribute('data-ai', '');
                added = true;
            }
            const paragraphs = Array.isArray(data.copy)
                ? data.copy.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
                : [];
            if (wantCopy && paragraphs.length && swapInCopy(copyEl, paragraphs)) added = true;
            if (added) creditAi();
        })
        .catch(() => {});
}

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
