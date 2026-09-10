import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export function Explainer() {
    return (
        <Accordion type="single" collapsible className="mb-6">
            <AccordionItem value="what-is-afd">
                <AccordionTrigger>What is an Area Forecast Discussion?</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
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
