type RequestCompletionHandler = (providerKey: string) => void;

let completionHandler: RequestCompletionHandler | undefined;

export function setRequestCompletionHandler(handler: RequestCompletionHandler): void {
    completionHandler = handler;
}

export function notifyRequestCompleted(providerKey: string): void {
    completionHandler?.(providerKey);
}
