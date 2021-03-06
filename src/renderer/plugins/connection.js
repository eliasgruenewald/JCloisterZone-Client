import { EventEmitter } from 'events'

import WebSocket from 'ws'
import Vue from 'vue'
import { randomId } from '@/utils/random'

import { getAppVersion } from '@/utils/version'
import { CONSOLE_CLIENT_COLOR } from '@/constants/logging'
import { NETWORK_PROTOCOL_COMPATIBILITY } from '@/constants/versions'
import { HEARTBEAT_INTERVAL } from '@/constants/ws'

const isDev = process.env.NODE_ENV === 'development'

class ConnectionPlugin {
  constructor (app) {
    this.app = app
    this.ws = null
    this.recentlyUsedSourceHash = null
    this.emitter = new EventEmitter()
  }

  // TODO use emitter instead callback
  async connect (host, { onMessage, onClose }) {
    let closeCalled = false
    let fulfilled = false
    let pingTimeout = null

    const handleClose = code => {
      if (onClose && !closeCalled) {
        closeCalled = true // call it only once. error event can be emited after close
        onClose(code)
      }
    }

    return new Promise((resolve, reject) => {
      const heartbeat = () => {
        clearTimeout(pingTimeout)
        pingTimeout = setTimeout(() => {
          this.ws.terminate()
        }, HEARTBEAT_INTERVAL + 2000)
      }

      console.log('%c client %c trying to connect to ' + host, CONSOLE_CLIENT_COLOR, '')
      this.ws = new WebSocket(host)
      this.ws.addEventListener('open', () => {
        console.log('%c client %c connected to ' + host, CONSOLE_CLIENT_COLOR, '')
        const appVersion = getAppVersion()
        const engineVersion = this.app.store.state.engine.version
        const { settings } = this.app.store.state
        this.ws.send(JSON.stringify({
          id: randomId(),
          type: 'HELLO',
          payload: {
            appVersion,
            engineVersion,
            protocolVersion: NETWORK_PROTOCOL_COMPATIBILITY,
            name: settings.nickname,
            clientId: settings.clientId,
            secret: settings.secret
          }
        }))
        heartbeat()
      })

      this.ws.addEventListener('ping', heartbeat)

      this.ws.addEventListener('error', e => {
        console.log(`%c client %c websocket error ${e.message}`, CONSOLE_CLIENT_COLOR, '')
        this.ws = null
        if (!fulfilled) {
          reject(e)
        }
        handleClose(null)
      })

      this.ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data)
        if (isDev) {
          console.log('%c client %c received message', CONSOLE_CLIENT_COLOR, '')
          console.debug(msg)
        }
        // console.debug(`%c client %c received ${msg.type}`, CONSOLE_CLIENT_COLOR, '')
        if (msg.type === 'ERR') {
          if (!fulfilled) {
            fulfilled = true
            reject(msg)
          }
          this.emitter.emit('error', msg.payload)
          return
        }
        if (msg.type === 'WELCOME') {
          console.log('%c client %c session id assigned ' + msg.payload.sessionId, CONSOLE_CLIENT_COLOR, '')
          fulfilled = true
          resolve()
        }
        onMessage(msg)
        this.emitter.emit('message', msg)
      })

      this.ws.addEventListener('close', ev => {
        clearTimeout(pingTimeout)
        console.log(`%c client %c websocket closed  code: ${ev.code} reason: ${ev.reason}`, CONSOLE_CLIENT_COLOR, '')
        this.ws = null
        this.emitter.emit('close', ev)
        if (!fulfilled) {
          reject(ev)
        }
        handleClose(ev.code)
      })
    })
  }

  disconnect () {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this.recentlyUsedSourceHash = null
    }
  }

  send (message) {
    // ignored messages when client is disconnected
    if (this.ws) {
      if (message.sourceHash) {
        if (message.sourceHash === this.recentlyUsedSourceHash) {
          // duplicate message
          return false
        }

        // set protection for next 1s => do not send message with same origin during this time
        this.recentlyUsedSourceHash = message.sourceHash
        setTimeout(() => {
          if (this.recentlyUsedSourceHash === message.sourceHash) {
            this.recentlyUsedSourceHash = null
          }
        }, 1000)
      }
      if (!message.id) {
        message = { id: randomId(), ...message }
      }
      this.ws.send(JSON.stringify(message))
      return true
    }
    return false
  }

  isConnectedOrConnecting () {
    return this.ws !== null
  }

  on (eventName, listener) {
    return this.emitter.on(eventName, listener)
  }

  once (eventName, listener) {
    return this.emitter.once(eventName, listener)
  }

  off (eventName, listener) {
    return this.emitter.off(eventName, listener)
  }
}

export default ({ app }, inject) => {
  Vue.prototype.$connection = new ConnectionPlugin(app)
}
