import { Lightbulb } from 'lucide-react';

import { OFFICE_NAMES } from '@data/offices.js';
import { confidenceScore, confidenceWord } from '@data/timeline.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const CONF_BAR = {
    High: 'bg-chart-2',
    Moderate: 'bg-chart-2',
    Mixed: 'bg-chart-5',
    Low: 'bg-destructive',
};

export function PageIntro({ office, takeawayHTML, forecaster, issueLine, fullText }) {
    const score = confidenceScore(fullText);
    const label = confidenceWord(score);

    return (
        <section className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">
                {OFFICE_NAMES[office]} <span className="text-muted-foreground">({office})</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
                Area Forecast Discussion — the National Weather Service forecast, decoded into plain English.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {issueLine && <span>{issueLine}</span>}
                {forecaster && <span>Forecaster: {forecaster}</span>}
                {label && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="inline-flex cursor-default items-center gap-2">
                                <span>Confidence</span>
                                <Progress
                                    value={score}
                                    indicatorClassName={CONF_BAR[label]}
                                    className="w-20"
                                    aria-label={`Forecaster confidence: ${label}`}
                                />
                                <Badge variant={label === 'Low' ? 'destructive' : 'secondary'}>{label}</Badge>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            Read from the forecaster's own confidence language — score {score}%
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>

            {takeawayHTML && (
                <Alert className="mt-6">
                    <Lightbulb />
                    <AlertTitle>Key takeaway</AlertTitle>
                    <AlertDescription>
                        <div dangerouslySetInnerHTML={{ __html: takeawayHTML }} />
                    </AlertDescription>
                </Alert>
            )}
        </section>
    );
}
