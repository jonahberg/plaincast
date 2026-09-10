// Small time/format helpers (ported from docs/js/app.js).

export function timeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatIssueTime(date, tz) {
    try {
        return date.toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
        });
    } catch (e) {
        return date.toLocaleString();
    }
}
