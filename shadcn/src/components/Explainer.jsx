import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export function Explainer() {
    return (
        <Accordion type="single" collapsible className="mb-8">
            <AccordionItem value="what-is-afd" className="border-y">
                <AccordionTrigger>What is an Area Forecast Discussion?</AccordionTrigger>
                <AccordionContent className="font-serif text-base leading-relaxed">
                    Area Forecast Discussions are the real forecasts, written 3 to 4 times daily
                    by NWS meteorologists reading the models and interpreting what they mean for
                    your area. They offer far deeper insight than any weather app, but they're
                    written in dense meteorological shorthand. Plaincast translates them into
                    plain English, side by side with the annotated original.
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
