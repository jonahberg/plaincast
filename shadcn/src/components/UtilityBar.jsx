import { useState } from 'react';
import { Check, Keyboard, Moon, Share2, Sun } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function UtilityBar({ office, onOfficeChange, onShowKbd, theme, onToggleTheme, selectRef }) {
    const [copied, setCopied] = useState(false);

    const share = async () => {
        const url = `${location.origin}${location.pathname}?office=${office}`;
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (e) { /* clipboard unavailable */ }
    };

    return (
        <div className="border-b bg-background/95">
            <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3 px-5 py-2.5 sm:px-8">
                <label className="flex items-center gap-2.5">
                    <span className="hidden font-sans text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:inline">
                        Forecast office
                    </span>
                    <Select value={office} onValueChange={onOfficeChange}>
                        <SelectTrigger ref={selectRef} size="sm" className="min-w-44" aria-label="NWS forecast office">
                            <SelectValue placeholder="Choose an office" />
                        </SelectTrigger>
                        <SelectContent>
                            {OFFICE_GROUPS.map(group => (
                                <SelectGroup key={group.label}>
                                    <SelectLabel>{group.label}</SelectLabel>
                                    {group.codes.map(code => (
                                        <SelectItem key={code} value={code}>
                                            {OFFICE_NAMES[code]} ({code})
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            ))}
                        </SelectContent>
                    </Select>
                </label>

                <div className="flex items-center gap-1.5">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm" onClick={share} aria-label="Share forecast link">
                                {copied ? <Check /> : <Share2 />}
                                <span className="hidden sm:inline">{copied ? 'Copied' : 'Share'}</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy a link to this office's forecast</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={onShowKbd} aria-label="Keyboard shortcuts">
                                <Keyboard />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Keyboard shortcuts</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="Toggle dark mode">
                                {theme === 'dark' ? <Sun /> : <Moon />}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Toggle dark mode</TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
