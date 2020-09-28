import WebSocket from 'ws'
import { v4 as uuidv4 } from 'uuid';
import Vue from 'vue'

import camelCase from 'lodash/camelCase'
import groupBy from 'lodash/groupBy'

import { randomLong } from '@/utils/random'
import { ENGINE_MESSAGES } from '@/constants/messages'
import { CONSOLE_SERVER_COLOR } from '@/constants/logging'


export class GameServer {
  constructor (game, clientId) {
    this.game = {
      gameId: game.gameId,
      setup: game.setup,
      initialSeed: game.initialSeed || randomLong().toString(),
      replay: game.replay || [],
      gameAnnotations: game.gameAnnotations || {},
      slots: [],
      owner: null // owner session
      // clockStart: 0,
    }
    this.status = 'OPEN'
    this.ownerClientId = clientId
    this.wss = null
    this.clients = null
  }

  async start (port) {
    return new Promise(resolve => {
      this.clients = []
      this.wss = new WebSocket.Server({
        port
      }, () => {
        console.log('%c embedded server %c started', CONSOLE_SERVER_COLOR, '')
        resolve()
      })
      this.wss.on('connection', ws => this.onConnection(ws))

    })
  }

  async stop () {
    if (this.wss) {
      return new Promise(resolve => {
        this.wss.close(() => {
          console.log('%c embedded server %c stopped', CONSOLE_SERVER_COLOR, '')
          resolve()
        })
        this.clients = null
        this.wss = null
      })
    }
  }

  onConnection (ws) {
    ws.on('message', data => {
      const { type, payload } = JSON.parse(data)
      if (ENGINE_MESSAGES.has(type)) {
        if (this.status !== 'STARTED') {
          ws.send(JSON.stringify({type: 'ERR', payload: 'Game is not started'}))
          return
        }
        this.handleEngineMessage(ws, type, payload)
      } else {
        if (this.status !== 'OPEN') {
          ws.send(JSON.stringify({type: 'ERR', payload: 'Game is not open'}))
          return
        }
        const handler = this[camelCase('handle_' + type)]
        if (handler) {
          handler.call(this, ws, payload)
        } else {
          console.error("Unknown handler for " + type)
        }
      }
    })
    ws.on('close', code => {
      console.log('%c embedded server %c websocket connection closed ' + code, CONSOLE_SERVER_COLOR, '')
      if (this.clients === null) {
        return
      }

      const idx = this.clients.indexOf(ws)
      if (idx !== -1) {
        this.clients.splice(idx, 1)
      }

      const groupped = groupBy(this.game.slots, s => s.sessionId === ws.sessionId)
      console.log(groupped)
      if (groupped.true) {
        groupped.true.forEach(slot => {
          this.broadcast({
            type: 'SLOT',
            payload: { number: slot.number },
          })
        })
        this.game.slots = groupped.false || []
      }
    })
  }

  broadcast (msg) {
    const data = JSON.stringify(msg)
    for (let client of this.clients) {
      client.send(data)
    }
  }

  handleHello (ws, payload) {
    // const { appVersion, protocolVersion, nickname, clientId, secret } = payload
    const clientAlreadyConnected = this.clients.find(ws => ws.clientId === payload.clientTracking)
    if (clientAlreadyConnected && clientAlreadyConnected.secret !== payload.secret) {
      ws.send(JSON.stringify({ type: 'ERR', payload: "Secret doesn't match" }))
      ws.close()
      return
    }

    console.log(`%c embedded server %c client ${payload.clientId} connected`, CONSOLE_SERVER_COLOR, '')

    this.clients.push(ws)
    const sessionId = uuidv4()
    ws.sessionId = sessionId
    ws.clientId = payload.clientId
    ws.secret = payload.secret
    ws.name = payload.name
    ws.send(JSON.stringify({
      type: 'WELCOME',
      payload: {
        sessionId
      }
    }))

    if (this.game.owner === null && ws.clientId === this.ownerClientId) {
      this.game.owner = ws.sessionId
    }


    ws.send(JSON.stringify({
      type: 'GAME',
      payload: this.game
    }))
    this.game.slots.forEach(slot => {
      ws.send(JSON.stringify({
        type: 'SLOT',
        payload: slot,
      }))
    })
  }

  handleTakeSlot (ws, { number, name }) {
    const slot = {
      number,
      name: name || ws.name || '',
      order: this.game.slots.length + 1,
      sessionId: ws.sessionId,
      clientId: ws.clientId
    }
    this.game.slots.push(slot)
    this.broadcast({
      type: 'SLOT',
      payload: slot,
    })
  }

  handleUpdateSlot (ws, { number, name }) {
    const slot = this.game.slots.find(s => s.number === number)
    if (slot.sessionId !== ws.sessionId) {
      ws.send(JSON.stringify({type: 'ERR', payload: 'Slot is not assigned to your session'}))
      return
    }
    slot.name = name
    this.broadcast({
      type: 'SLOT',
      payload: slot,
    })
  }

  handleLeaveSlot (ws, { number }) {
    const idx = this.game.slots.findIndex(s => s.number === number)
    const slot = this.game.slots[idx]
    if (slot.sessionId !== ws.sessionId) {
      ws.send(JSON.stringify({type: 'ERR', payload: 'Slot is not assigned to your session'}))
      return
    }
    if (idx !== -1) {
      this.game.slots.splice(idx, 1)
      this.broadcast({
        type: 'SLOT',
        payload: { number },
      })
    }
  }

  handleStart (ws) {
    if (this.game.owner !== ws.sessionId) {
      ws.send(JSON.stringify({type: 'ERR', payload: 'Not a game owner'}))
      return
    }
    this.status = 'STARTED'
    this.broadcast({
      type: 'START',
      payload: {}
    })
  }

  handleEngineMessage (ws, type, payload) {
    const salted = ['COMMIT', 'FLOCK_EXPAND_OR_SCORE'].includes(type) || (type === 'DEPLOY_MEEPLE' && payload.pointer.location === 'FLYING_MACHINE')
    if (salted) {
      payload = {
        ...payload,
        salt: randomLong().toString()
      }
    }
    this.broadcast({ type, payload })
  }
}

export default ({ app }, inject) => {
  let gameServer = null
  let socket = null

  Vue.prototype.$server = {
    async start (game) {
      await this.stop()
      const { settings } = app.store.state
      gameServer = new GameServer(game, settings.clientId)
      await gameServer.start(settings.port)
    },

    async stop () {
      if (gameServer) {
        await gameServer.stop()
        gameServer = null
      }
    }
  }
}