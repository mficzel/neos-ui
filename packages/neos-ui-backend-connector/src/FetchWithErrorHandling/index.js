class FetchWithErrorHandling {
    /**
     * The current CSRF token being used.
     */
    _csrfToken = null;

    /**
     * In case a request failed because we are not logged in anymore, the following happens:
     *   - the failed request is put to this._requestQueue; so that it can be re-tried after a successful login.
     *   - this._shouldEnqueueRequests is set to TRUE, to ensure upcoming requests (which rely on authentication) will not be executed, but parked.
     */
    _authenticationErrorHandlerFn = null;
    _generalErrorHandlerFn = () => null;
    _shouldEnqueueRequests = false;
    _requestQueue = [];

    registerAuthenticationErrorHandler(handlerFn) {
        this._authenticationErrorHandlerFn = handlerFn;
    }

    registerGeneralErrorHandler(handlerFn) {
        this._generalErrorHandlerFn = handlerFn;
    }

    setCsrfToken(csrfToken) {
        this._csrfToken = csrfToken;
    }

    /**
     * MAIN ENTRY POINT, replacing the "fetch" API.
     *
     * does a "fetch" request with a CSRF token and automatic relogin if a login error occurs.
     *
     * FETCH example:
     *
     *     fn = csrfToken => (changes) => fetch('/your/url/here', {... fetch options here, use csrfToken ...})
     *
     * EXAMPLE of fetchWithCsrfTokenAndErrorHandling (rewrite your code like this):
     *
     *     fn = fetchWithCsrfTokenAndErrorHandling((changes) => csrfToken => ({
     *       url: '/your/url/here',
     *       ... fetch options here ...
     *       ... use csrfToken properly...
     *     }))
     *
     *
     * makeFetchRequest is a function which takes just the csrfToken as argument and returns the fetch request specification.
     */
    withCsrfToken(makeFetchRequest) {
        if (this._shouldEnqueueRequests) {
            // We are currently not authenticated anymore; so we know the request cannot work. Instead, we just enqueue it so that we can run it
            // once authentication is successful.
            return this._enqueueRequest(makeFetchRequest);
        }

        return this._executeFetchRequest(makeFetchRequest);
    }

    _enqueueRequest(makeFetchRequest) {
        return new Promise((resolve, reject) => {
            // This promise is never resolved inside the function body here; but it is resolved after a successful
            // re-login; when the requestQueue is executed (inside _executeSingleQueueElement)
            this._requestQueue.push({makeFetchRequest, resolve, reject});
        });
    }

    _executeFetchRequest(makeFetchRequest) {
        // Build the actual fetch request by passing in the current CSRF token
        const fetchOptions = makeFetchRequest(this._csrfToken);
        const url = fetchOptions.url;
        delete fetchOptions.url;

        // We manually return a new promise (and do not reuse the promise returned from fetch()), because
        // we need to be able to restart a new fetch() request on login failures; and make the outer promise
        // return only after the successful relogin.
        return new Promise((resolve, reject) =>
            fetch(url, fetchOptions).then(response => {
                if (response.ok) {
                    // CASE: all good; no errors!
                    resolve(response);
                } else if (response.status === 401) {
                    // CASE: Unauthorized!
                    // - all following requests have to fail; thus we enqueue them.
                    // - we enqueue our current request; so that it is re-run after successful re-login.
                    //   Note that _enqueueRequest returns a promise which is resolved only after successful re-login and successful request.
                    // - we trigger the _authenticationErrorHandlerFn (which then should display a login screen to the user; and when authentication
                    //   was successful, call updateCsrfTokenAndWorkThroughQueue)
                    this._shouldEnqueueRequests = true;
                    resolve(this._enqueueRequest(makeFetchRequest));
                    if (this._authenticationErrorHandlerFn) {
                        this._authenticationErrorHandlerFn();
                    }
                } else if (response.status >= 500) { // 50x error
                    response.text().then(text => {
                        // Rejected promise is caught later
                        reject(text);
                    });
                } else { // Other cases like 404, not necessarily an error
                    resolve(response);
                }
            }, reason => {
                // Network problems, rejected promise is caught later
                reject(reason);
            })
        );
    }

    /**
     * This method should be called after successful re-authentication and retrieving a new CSRF token. It re-executes
     * all requests currently in the waiting queue and resolves the original promises; so that the application can
     * continue working.
     */
    updateCsrfTokenAndWorkThroughQueue(newCsrfToken) {
        this.setCsrfToken(newCsrfToken);

        // Store the current request queue in a local variable (to ensure it is not modified while we replay them); and disable the queuing.
        const requestQueueToWorkThrough = this._requestQueue;
        this._shouldEnqueueRequests = false;
        this._requestQueue = [];

        // Execute the requests in the queue one-by-one (not in parallel), as there might be dependencies between the requests (unlikely, but
        // might be possible).
        let currentPromise = Promise.resolve(true);
        for (let i = 0; i < requestQueueToWorkThrough.length; i++) {
            currentPromise = this._executeSingleQueueElement(currentPromise, requestQueueToWorkThrough[i]);
        }
    }

    _executeSingleQueueElement(currentPromise, queueElement) {
        const {makeFetchRequest, resolve, reject} = queueElement;
        return currentPromise.then(() => {
            // We execute our request; and if we were successful, resolve or reject the *original* promise (which is stored in the queueElement).
            return this._executeFetchRequest(makeFetchRequest)
                .then(result => resolve(result), error => reject(error));
        });
    }

    /**
     * Every request that is supposed to show an error message on failure (i.e. any request),
     * should end with this catch block:
     * `.catch(reason => fetchWithErrorHandling.generalErrorHandler(reason))`
     */
    generalErrorHandler(reason) {
        let errorText;
        if (typeof reason === 'string') {
            errorText = reason;
        } else if (reason instanceof Error) {
            errorText = reason.message;
        } else {
            errorText = String(reason);
        }
        this._generalErrorHandlerFn(errorText);
        // Re-throw, so the promise chain would be interrupted
        throw new Error(errorText);
    }

    /**
     * Safely parse JSON from response
     */
    parseJson(response) {
        return response.text().then(response => {
            try {
                return JSON.parse(response);
            } catch (e) {
                const tmp = document.createElement('div');
                tmp.innerHTML = response;
                throw new Error(tmp.textContent || response);
            }
        });
    }
}

const fetchWithErrorHandling = new FetchWithErrorHandling();
export default fetchWithErrorHandling;
