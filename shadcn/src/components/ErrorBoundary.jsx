import { Component } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

// Two uses: the app-wide boundary in main.jsx (last resort — reload), and a
// per-view boundary in App.jsx (`scoped`) so one view's crash leaves the
// header, office picker and footer working. A scoped boundary clears itself
// when `resetKey` changes (switching office or view), and its retry button
// re-mounts the view instead of reloading the page.
export class ErrorBoundary extends Component {
    state = { error: null };

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('Plaincast crashed', error, info);
    }

    componentDidUpdate(prevProps) {
        if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ error: null });
        }
    }

    render() {
        if (!this.state.error) return this.props.children;
        const { scoped } = this.props;
        return (
            <div className={scoped ? '' : 'mx-auto max-w-lg px-4 py-16'}>
                <Alert variant="destructive">
                    <AlertTitle>{scoped ? 'This view hit a snag' : 'Something broke'}</AlertTitle>
                    <AlertDescription>
                        <p>{String(this.state.error?.message || this.state.error)}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={() => (scoped ? this.setState({ error: null }) : location.reload())}
                        >
                            {scoped ? 'Try again' : 'Reload'}
                        </Button>
                    </AlertDescription>
                </Alert>
            </div>
        );
    }
}
