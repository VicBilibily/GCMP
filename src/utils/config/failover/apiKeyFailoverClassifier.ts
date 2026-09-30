import { isCancellationError } from '../../text/cancellationError';

export function isApiKeyFailoverError(error: unknown): boolean {
    return !isCancellationError(error);
}
