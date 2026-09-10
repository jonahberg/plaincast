import { confidenceScore, confidenceWord } from '@data/timeline.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const CONF_STYLE = {
    High: { badge: 'advisory', bar: 'bg-[#16A34A] dark:bg-[#4ADE80]' },
    Moderate: { badge: 'advisory', bar: 'bg-primary' },
    Mixed: { badge: 'warning', bar: 'bg-amber' },
    Low: { badge: 'destructive', bar: 'bg-destructive' },
};

export function Lede({ takeawayHTML, forecaster, issueLine, fullText }) {
    const score = confidenceScore(fullText);
    const label = confidenceWord(score);
    const conf = label ? CONF_STYLE[label] : null;

    return (
        <section className="mb-10">
            <div className="mb-3 text-center font-sans text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-[#8A2B18] dark:text-[#E0A899]">
                The Lede
            </div>
            <Alert variant="takeaway">
                <AlertTitle className="font-sans text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-primary">
                    Key Takeaway
                </AlertTitle>
                <AlertDescription className="text-foreground">
                    <div
                        className="font-serif text-[1.1rem] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: takeawayHTML }}
                    />
                </AlertDescription>
            </Alert>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-sans text-[0.8rem] text-muted-foreground">
                {forecaster && (
                    <span className="italic">
                        Reported by forecaster {forecaster}
                    </span>
                )}
                {forecaster && issueLine && <span aria-hidden="true">·</span>}
                {issueLine && <span>{issueLine}</span>}
                {label && (
                    <>
                        <span aria-hidden="true">·</span>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex cursor-default items-center gap-2">
                                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.08em]">
                                        Forecaster's confidence
                                    </span>
                                    <Progress
                                        value={score}
                                        indicatorClassName={conf.bar}
                                        className="w-16"
                                        aria-label={`Forecaster confidence: ${label}`}
                                    />
                                    <Badge variant={conf.badge}>{label}</Badge>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>
                                Read from the forecaster's own confidence language — score {score}%
                            </TooltipContent>
                        </Tooltip>
                    </>
                )}
            </div>
        </section>
    );
}
