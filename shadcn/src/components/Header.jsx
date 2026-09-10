import { useState } from 'react';
import { Check, CloudSun, Github, Keyboard, Moon, Share2, Sun } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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

export function Header({ office, onOfficeChange, onShowKbd, theme, onToggleTheme, selectRef }) {
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
        <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
                <a href="/" className="flex items-center gap-2 font-semibold">
                    <CloudSun className="size-5" aria-hidden="true" />
                    <span>Plaincast</span>
                </a>

                <Separator orientation="vertical" className="hidden !h-5 sm:block" />

                <Select value={office} onValueChange={onOfficeChange}>
                    <SelectTrigger ref={selectRef} size="sm" className="w-full max-w-56 sm:w-56" aria-label="NWS forecast office">
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

                <div className="ml-auto flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={share} aria-label="Share forecast link">
                                {copied ? <Check /> : <Share2 />}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{copied ? 'Link copied' : 'Copy link to this forecast'}</TooltipContent>
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
                            <Button variant="ghost" size="icon" asChild>
                                <a
                                    href="https://github.com/jonahberg/plaincast"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Source on GitHub"
                                >
                                    <Github />
                                </a>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Source on GitHub</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="Toggle dark mode">
                                {theme === 'dark' ? <Sun /> : <Moon />}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Toggle theme</TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </header>
    );
}
