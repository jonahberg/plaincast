import { Component } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export class ErrorBoundary extends Component {
    state = { error: null };

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('Plaincast crashed', error, info);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="mx-auto max-w-lg px-4 py-16">
                <Alert variant="destructive">
                    <AlertTitle>Something broke</AlertTitle>
                    <AlertDescription>
                        <p>{String(this.state.error?.message || this.state.error)}</p>
                        <Button variant="outline" size="sm" className="mt-2" onClick={() => location.reload()}>
                            Reload
                        </Button>
                    </AlertDescription>
                </Alert>
            </div>
        );
    }
}
