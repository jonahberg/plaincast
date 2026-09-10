export function Footer({ office, rawUrl }) {
    return (
        <footer className="border-t">
            <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:px-6">
                <p>
                    Data from the{' '}
                    <a
                        className="font-medium underline underline-offset-4 hover:text-foreground"
                        href="https://www.weather.gov"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        National Weather Service
                    </a>
                    , office {office}.
                </p>
                <p className="flex items-center gap-3">
                    {rawUrl && (
                        <a
                            className="underline underline-offset-4 hover:text-foreground"
                            href={rawUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Original discussion
                        </a>
                    )}
                    <a
                        className="underline underline-offset-4 hover:text-foreground"
                        href="https://ui.shadcn.com"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Built with shadcn/ui
                    </a>
                </p>
            </div>
        </footer>
    );
}
