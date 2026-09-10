import { OFFICE_NAMES } from '@data/offices.js';
import { OFFICE_GROUPS } from '@/lib/offices-groups';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

// Every office as a pill — the vanilla client's office-index footer nav,
// switching in place instead of navigating to /o/<CODE>/.
export function OfficeIndex({ office, onOfficeChange }) {
    return (
        <nav aria-label="All Plaincast forecast offices" className="pb-8">
            <Separator className="mb-6" />
            <h2 className="mb-4 text-center font-sans text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                The forecast, office by office
            </h2>
            <div className="space-y-4">
                {OFFICE_GROUPS.map(group => (
                    <div key={group.label}>
                        <div className="mb-2 font-sans text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            {group.label}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {group.codes.map(code => (
                                <Button
                                    key={code}
                                    variant={code === office ? 'secondary' : 'ghost'}
                                    size="pill"
                                    className={code === office
                                        ? 'border-primary text-primary'
                                        : 'border-transparent text-muted-foreground'}
                                    onClick={() => onOfficeChange(code)}
                                >
                                    {OFFICE_NAMES[code]} ({code})
                                </Button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </nav>
    );
}
