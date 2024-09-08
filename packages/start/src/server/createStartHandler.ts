import { eventHandler, getResponseHeaders, toWebRequest } from 'vinxi/http'
import { createMemoryHistory } from '@tanstack/react-router'
import { serializeLoaderData } from '../client/serialization'
import { mergeHeaders } from '../client/headers'
import {
  serverFnPayloadTypeHeader,
  serverFnReturnTypeHeader,
} from '../constants'
import { findAPIRoute, toTSRFileBasedRoutes, vinxiRoutes } from '../api'
import type { APIRouteReturnType, HTTP_API_METHOD } from '../api'
import type { EventHandler, EventHandlerRequest, H3Event } from 'vinxi/http'
import type { AnyRouter, Manifest } from '@tanstack/react-router'
import type { HandlerCallback } from './defaultStreamHandler'

export type CustomizeStartHandler<TRouter extends AnyRouter> = (
  cb: HandlerCallback<TRouter>,
) => EventHandler

export function createStartHandler<TRouter extends AnyRouter>({
  createRouter,
  getRouterManifest,
}: {
  createRouter: () => TRouter
  getRouterManifest?: () => Manifest
}): CustomizeStartHandler<TRouter> {
  return (cb) => {
    return eventHandler(async (event) => {
      const request = toWebRequest(event)

      const url = new URL(request.url)
      const href = url.href.replace(url.origin, '')

      // api
      const apiUrl = new URL(request.url, 'http://localhost:3000')
      const apiRoutes = toTSRFileBasedRoutes(vinxiRoutes)
      const apiRouteMatch = findAPIRoute(apiUrl, apiRoutes)
      if (apiRouteMatch) {
        let action: APIRouteReturnType | undefined = undefined

        /**
         * TODO: Figure out what happens next over here.
         * We'd likely be doing proxying over to server functions in here.
         * Its not the cleanest thing, plus we'd need to write an internal
         * SSR handler for possible TanStack Start SPA mode with API routes.
         */

        try {
          // We can guarantee that action is defined since we filtered for it earlier
          action = await apiRouteMatch.payload
            .$APIRoute!.import()
            .then((m) => m.Route)
        } catch (err) {
          // If we can't import the route file, return a 500
          console.error('Error importing route file:', err)
          return new Response('Internal server error', { status: 500 })
        }

        // If we don't have an action, return a 500
        if (!action) {
          return new Response('Internal server error', { status: 500 })
        }

        const method = request.method as HTTP_API_METHOD

        // Get the handler for the request method based on the Request Method
        const handler = action.methods[method]

        // If the handler is not defined, return a 405
        // What this means is that we have a route that matches the request
        // but we don't have a handler for the request method
        // i.e we have a route that matches /api/foo/$ but we don't have a POST handler
        if (!handler) {
          return new Response('Method not allowed', { status: 405 })
        }

        const apiResponse = await handler({
          request,
          params: apiRouteMatch.params,
        })
        return apiResponse
      }

      // render
      // Create a history for the router
      const history = createMemoryHistory({
        initialEntries: [href],
      })

      const router = createRouter()

      // Inject a few of the SSR helpers and defaults
      router.serializeLoaderData = serializeLoaderData as any

      if (getRouterManifest) {
        router.manifest = getRouterManifest()
      }

      // Update the router with the history and context
      router.update({
        history,
      })

      await router.load()

      const responseHeaders = getRequestHeaders({
        event,
        router,
      })

      const response = await cb({
        request,
        router,
        responseHeaders,
      })

      return response
    })
  }
}

function getRequestHeaders(opts: {
  event: H3Event<EventHandlerRequest>
  router: AnyRouter
}): Headers {
  ;(opts.event as any).__tsrHeadersSent = true

  let headers = mergeHeaders(
    getResponseHeaders(opts.event),
    {
      'Content-Type': 'text/html; charset=UTF-8',
    },
    ...opts.router.state.matches.map((match) => {
      return match.headers
    }),
  )

  // Handle Redirects
  const { redirect } = opts.router.state

  if (redirect) {
    headers = mergeHeaders(headers, redirect.headers, {
      Location: redirect.href,
    })
  }

  // Remove server function headers
  ;[serverFnReturnTypeHeader, serverFnPayloadTypeHeader].forEach((header) => {
    headers.delete(header)
  })

  return headers
}
