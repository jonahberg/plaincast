import { Separator } from '@/components/ui/separator';

export function Colophon({ office, rawUrl }) {
    return (
        <footer className="pb-10 pt-4 text-center font-sans text-[0.8rem] text-muted-foreground">
            <Separator className="mb-6" />
            <p className="mb-2">
                <span aria-hidden="true" className="mr-1 text-base">❧</span>
                Reported by the{' '}
                <a
                    className="text-primary hover:underline"
                    href="https://www.weather.gov"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    National Weather Service, {office}
                </a>
                . Set in shadcn/ui.
            </p>
            <p className="flex flex-wrap items-center justify-center gap-x-2">
                {rawUrl && (
                    <>
                        <a
                            className="text-primary hover:underline"
                            href={rawUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Read the original discussion
                        </a>
                        <span aria-hidden="true">·</span>
                    </>
                )}
                <a
                    className="text-primary hover:underline"
                    href="https://github.com/jonahberg/plaincast"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Source on GitHub
                </a>
                <span aria-hidden="true">·</span>
                <span>
                    Set by{' '}
                    <a
                        className="text-primary hover:underline"
                        href="https://jonahberg.com"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Jonah Berg
                    </a>
                </span>
            </p>
        </footer>
    );
}
