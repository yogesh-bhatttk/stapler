import { Component, type ComponentChildren } from 'preact';
import { EmptyState } from './Feedback';
import { Button } from './Button';
import { translate } from '../../core/i18n';

export interface ErrorBoundaryProps {
  children: ComponentChildren;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <EmptyState
          title={translate('Something went wrong')}
          body={
            this.state.error?.message ||
            translate('An unexpected error caused the editor to crash.')
          }
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              {translate('Reload App')}
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
