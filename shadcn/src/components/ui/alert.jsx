import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva(
    'relative w-full rounded-md border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
    {
        variants: {
            variant: {
                default: 'bg-card text-card-foreground',
                destructive: 'text-destructive bg-card [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90',
                takeaway: 'border-l-[3px] border-l-primary border-y-0 border-r-0 rounded-l-none bg-teal-light text-foreground',
                warning: 'border-l-[3px] border-l-amber border-y-0 border-r-0 rounded-l-none bg-amber-light text-foreground',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    }
);

function Alert({ className, variant, ...props }) {
    return (
        <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
    );
}

function AlertTitle({ className, ...props }) {
    return (
        <div
            data-slot="alert-title"
            className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }) {
    return (
        <div
            data-slot="alert-description"
            className={cn('text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed', className)}
            {...props}
        />
    );
}

export { Alert, AlertTitle, AlertDescription };
