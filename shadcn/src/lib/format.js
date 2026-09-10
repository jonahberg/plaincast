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

export function localHour(date, tz) {
    try {
        return parseInt(date.toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }));
    } catch (e) {
        return date.getHours();
    }
}

// AFDs are issued ~4x daily; name the edition by local issue hour.
export function editionName(hour) {
    if (hour >= 3 && hour < 9) return 'Morning Edition';
    if (hour >= 9 && hour < 14) return 'Midday Edition';
    if (hour >= 14 && hour < 20) return 'Evening Edition';
    return 'Overnight Edition';
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
