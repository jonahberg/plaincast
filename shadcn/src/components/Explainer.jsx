import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

// A quiet aside under the almanac. Its trigger is an h2: it sits between the
// page h1 and the section h2s, so an h3 here broke heading order.
export function Explainer() {
    return (
        <Accordion type="single" collapsible className="mt-2">
            <AccordionItem value="what-is-afd">
                <AccordionTrigger
                    headingLevel={2}
                    className="py-3 font-normal text-muted-foreground hover:text-foreground hover:no-underline"
                >
                    What is an Area Forecast Discussion?
                </AccordionTrigger>
                <AccordionContent className="max-w-[65ch] leading-6 text-muted-foreground">
                    Area Forecast Discussions are the real forecasts, written 3 to 4 times daily
                    by NWS meteorologists reading the models and interpreting what they mean for
                    your area. They offer far deeper insight than any weather app, but they're
                    written in dense meteorological shorthand. Plaincast translates them into
                    plain English, with every jargon term explained.
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
