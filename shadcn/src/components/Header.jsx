import { CloudSun, Github, Keyboard, LocateFixed, Moon, Share2, Sun } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';

import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { findNearestOffice } from '@/lib/nws';
import { officeTitle } from '@/lib/seo';
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

export function Header({
    office, shareUrl, onOfficeChange, onShowKbd, theme, onToggleTheme, selectRef,
    pickerOpen, onPickerOpenChange,
}) {
    // After a pick, focus must NOT return to the trigger: a focused trigger
    // swallows the j/k shortcuts (and, before select.jsx blocked it, typeahead-
    // switched offices on them). Escape still restores focus normally.
    const justPicked = useRef(false);
    const pick = (code) => {
        justPicked.current = true;
        onOfficeChange(code);
    };

    const share = async () => {
        const title = officeTitle(OFFICE_NAMES[office]);
        if (navigator.share) {
            try {
                await navigator.share({ title, url: shareUrl });
                return;
            } catch (e) {
                if (e.name === 'AbortError') return; // user closed the sheet
            }
        }
        try {
            await navigator.clipboard.writeText(shareUrl);
            toast.success('Link copied', { description: shareUrl });
        } catch (e) {
            toast.error("Couldn't copy the link");
        }
    };

    const locate = () => {
        if (!navigator.geolocation) {
            toast.error('Geolocation is not available in this browser');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const detected = findNearestOffice(pos.coords.latitude, pos.coords.longitude);
                if (!detected) return;
                if (detected === office) {
                    toast.success(`${OFFICE_NAMES[detected]} (${detected}) is already your nearest office`);
                    return;
                }
                onOfficeChange(detected);
                toast.success(`Showing ${OFFICE_NAMES[detected]} (${detected}), your nearest office`);
            },
            () => toast.error("Couldn't read your location"),
            { timeout: 8000 }
        );
    };

    return (
        <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            {/* 320–375px budget: icon-only wordmark, a flexible picker, and
                only locate/share/theme — shortcuts + GitHub return at sm (the
                footer carries the GitHub link at every width). */}
            <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
                <a href="/" className="flex shrink-0 items-center gap-2 font-semibold" aria-label="Plaincast home">
                    <CloudSun className="size-5" aria-hidden="true" />
                    <span className="hidden sm:inline">Plaincast</span>
                </a>

                <Separator orientation="vertical" className="hidden !h-5 sm:block" />

                <Select value={office} onValueChange={pick} open={pickerOpen} onOpenChange={onPickerOpenChange}>
                    <SelectTrigger
                        ref={selectRef}
                        size="sm"
                        className="w-auto min-w-0 flex-1 sm:w-56 sm:flex-none"
                        aria-label="NWS forecast office"
                    >
                        <SelectValue placeholder="Choose an office" />
                    </SelectTrigger>
                    <SelectContent
                        onCloseAutoFocus={(e) => {
                            if (!justPicked.current) return;
                            justPicked.current = false;
                            e.preventDefault();
                        }}
                    >
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

                <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={locate} aria-label="Use my location">
                                <LocateFixed />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Find my nearest office</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" onClick={share} aria-label="Share forecast link">
                                <Share2 />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Share this forecast</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost" size="icon" onClick={onShowKbd}
                                aria-label="Keyboard shortcuts" className="hidden sm:inline-flex"
                            >
                                <Keyboard />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Keyboard shortcuts</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" asChild className="hidden sm:inline-flex">
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
