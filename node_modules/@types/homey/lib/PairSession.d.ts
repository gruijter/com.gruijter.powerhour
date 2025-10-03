export = PairSession;
/**
 * PairSession is returned by {@link Driver#onPair}.
 * @hideconstructor
 */
declare class PairSession {
    /**
     * @callback PairSession.Handler
     * @param {any} data
     * @returns {Promise<any>}
     */
    /**
     * Register a handler for an event.
     * setHandler accepts async functions that can receive and respond to messages from the pair view.
     * @param {string} event
     * @param {PairSession.Handler} handler
     */
    setHandler(event: string, handler: PairSession.Handler): PairSession;

    /**
     * @param {string} event
     * @param {any} data
     * @returns {Promise<any>}
     */
    emit(event: string, data: any): Promise<any>

    /**
     * Show a specific pairing step by its id.
     * @param {string} viewId
     * @returns {Promise<void>}
     */
    showView(viewId: string): Promise<void>

    /**
     * Go to the next pairing step.
     * @returns {Promise<void>}
     */
    nextView(): Promise<void>

    /**
     * Go back to the previous pairing step.
     * @returns {Promise<void>}
     */
    prevView(): Promise<void>

    /**
     * Close the pairing session.
     * @returns {Promise<void>}
     */
    done(): Promise<void>
}
declare namespace PairSession {
    type Handler = (data: any) => Promise<any>;
}
