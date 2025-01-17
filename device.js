const EventEmitter = require('events')
// const { createCanvas } = require('canvas')
const rgba = require('color-rgba')

const {
    BUTTONS,
    DISPLAYS,
    HAPTIC,
    HEADERS,
    MAX_BRIGHTNESS,
    RECONNECT_INTERVAL,
} = require('./constants')
const WSConnection = require('./connections/ws')
const SerialConnection = require('./connections/serial')
const listDevices = require('./discover')

class LoupedeckDevice extends EventEmitter {
    constructor({ host, path, autoConnect = true } = {}) {
        super()
        this.transactionID = 0
        this.touches = {}
        this.handlers = {
            [HEADERS.BUTTON_PRESS]: this.onButton.bind(this),
            [HEADERS.KNOB_ROTATE]: this.onRotate.bind(this),
            [HEADERS.SERIAL_IN]: this.onSerial.bind(this),
            [HEADERS.TICK]: () => {},
            [HEADERS.TOUCH]: this.onTouch.bind(this, 'touchmove'),
            [HEADERS.TOUCH_END]: this.onTouch.bind(this, 'touchend'),
            [HEADERS.VERSION_IN]: this.onVersion.bind(this),
        }
        // Track pending transactions
        this.pendingTransactions = {}
        // How long between reconnect attempts
        this.reconnectInterval = RECONNECT_INTERVAL
        // Host for websocket connections
        this.host = host
        // Path for serial connections
        this.path = path
        // Automatically connect?
        if (autoConnect) this.connect()
    }
    close() {
        if (!this.connection) return
        this.connection.close()
    }
    async connect() {
        // Explicitly asked for a serial connection (V0.2.X)
        if (this.path) this.connection = new SerialConnection({ path: this.path })
        // Explicitly asked for a websocket connection (V0.1.X)
        else if (this.host) this.connection = new WSConnection({ host: this.host })
        // Autodiscover
        else {
            const devices = await listDevices()
            if (devices.length > 0) {
                const devInfo = devices[0]
                switch (devInfo.type) {
                    case 'ws':
                        this.connection = new WSConnection({ host: devInfo.host })
                        break
                    case 'serial':
                        this.connection = new SerialConnection({ path: devInfo.path })
                        break
                    default:
                        // Unknown
                        break
                }
            }
            if (!this.connection) return Promise.resolve(this.onDisconnect(new Error('No devices found')))
        }

        this.connection.on('connect', this.onConnect.bind(this))
        this.connection.on('message', this.onReceive.bind(this))
        this.connection.on('disconnect', this.onDisconnect.bind(this))

        const connectionPromise = new Promise(res => {
            this._connectionResolver = res
        })
        this.connection.connect()
        return connectionPromise
    }
    // // Create a canvas with correct dimensions and pass back for drawing
    // async drawCanvas({ id, width, height, x = 0, y = 0, autoRefresh = true }, cb) {
    //     const displayInfo = DISPLAYS[id]
    //     if (!width) width = displayInfo.width
    //     if (!height) height = displayInfo.height

    //     const canvas = createCanvas(width, height)
    //     const ctx = canvas.getContext('2d', { pixelFormat: 'RGB16_565' }) // Loupedeck uses 16-bit (5-6-5) LE RGB colors
    //     cb(ctx, width, height)

    //     // Header with x/y/w/h and display ID
    //     const header = Buffer.alloc(8)
    //     header.writeUInt16BE(x, 0)
    //     header.writeUInt16BE(y, 2)
    //     header.writeUInt16BE(width, 4)
    //     header.writeUInt16BE(height, 6)

    //     // Write to frame buffer
    //     await this.send(HEADERS.WRITE_FRAMEBUFF, Buffer.concat([displayInfo.id, header, canvas.toBuffer('raw')]), { track: true })

    //     // Draw to display
    //     if (autoRefresh) await this.refresh(id)
    // }
    // Create a canvas with correct dimensions and pass back for drawing
    async drawBuffer({ id, width, height, x = 0, y = 0, buffer, autoRefresh = true }) {
        const displayInfo = DISPLAYS[id]
        if (!width) width = displayInfo.width
        if (!height) height = displayInfo.height

        const pixelCount = width * height
        if (buffer.length !== pixelCount * 3) {
            throw new Error(`Incorrect buffer length ${buffer.length} expected ${pixelCount * 3}`)
        }

        const converted = Buffer.alloc(pixelCount * 2)
        for (let i = 0; i < pixelCount; i++) {
            const r = buffer.readUInt8(i * 3 + 0) >> 3
            const g = buffer.readUInt8(i * 3 + 1) >> 2
            const b = buffer.readUInt8(i * 3 + 2) >> 3

            converted.writeUint16LE((r << 11) + (g << 5) + b, i * 2)
        }

        // Header with x/y/w/h and display ID
        const header = Buffer.alloc(8)
        header.writeUInt16BE(x, 0)
        header.writeUInt16BE(y, 2)
        header.writeUInt16BE(width, 4)
        header.writeUInt16BE(height, 6)

        // Write to frame buffer
        await this.send(HEADERS.WRITE_FRAMEBUFF, Buffer.concat([displayInfo.id, header, converted]), { track: true })

        // Draw to display
        if (autoRefresh) await this.refresh(id)
    }
    // // Draw to a specific key index (0-12)
    // drawKey(index, cb) {
    //     // Get offset x/y for key index
    //     const width = 90
    //     const height = 90
    //     const x = index % 4 * width
    //     const y = Math.floor(index / 4) * height
    //     return this.drawCanvas({ id: 'center', x, y, width, height }, cb)
    // }
    // // Draw to a specific screen
    // drawScreen(id, cb) {
    //     return this.drawCanvas({ id }, cb)
    // }
    // Draw to a specific key index (0-12)
    drawKeyBuffer(index, buffer) {
        // Get offset x/y for key index
        const width = 90
        const height = 90
        const x = index % 4 * width
        const y = Math.floor(index / 4) * height
        return this.drawBuffer({ id: 'center', x, y, width, height, buffer })
    }
    // Draw to a specific screen
    drawScreenBuffer(id, buffer) {
        return this.drawBuffer({ id, buffer })
    }
    async getInfo() {
        const [serial, version] = await Promise.all([
            this.send(HEADERS.SERIAL_OUT, undefined, { track: true }),
            this.send(HEADERS.VERSION_OUT, undefined, { track: true }),
        ])
        return { serial, version }
    }
    onButton(buff) {
        const id = BUTTONS[buff[0]]
        const event = buff[1] === 0x00 ? 'down' : 'up'
        this.emit(event, { id })
    }
    onConnect(info) {
        this.emit('connect', info)
        this._connectionResolver()
    }
    onDisconnect(error) {
        this.emit('disconnect', error)
        clearTimeout(this._keepAliveTimer)
        this.connection = null
        // Normal disconnect, do not reconnect
        if (!error) return
        this._reconnectTimer = setTimeout(this.connect.bind(this), this.reconnectInterval)
    }
    onReceive(buff) {
        const header = buff.readUInt16BE()
        const handler = this.handlers[header]
        const transactionID = buff[2]
        const response = handler ? handler(buff.slice(3)) : buff
        const resolver = this.pendingTransactions[transactionID]
        if (resolver) resolver(response)
        return response
    }
    onRotate(buff) {
        const id = BUTTONS[buff[0]]
        const delta = buff.readInt8(1)
        this.emit('rotate', { id, delta })
    }
    onSerial(buff) {
        return buff.toString().trim()
    }
    onTouch(event, buff) {
        const x = buff.readUInt16BE(1)
        const y = buff.readUInt16BE(3)
        const id = buff[5]

        // Determine target
        const screen = x < 60 ? 'left' : x >= 420 ? 'right' : 'center'
        let key
        if (screen === 'center') {
            const column = Math.floor((x - 60) / 90)
            const row = Math.floor(y / 90)
            key = row * 4 + column
        }

        // Create touch
        const touch = { x, y, id, target: { screen, key } }

        // End touch, remove from local cache
        if (event === 'touchend') {
            delete this.touches[touch.id]
        }
        else {
            // First time seeing this touch, emit touchstart instead of touchmove
            if (!this.touches[touch.id]) event = 'touchstart'
            this.touches[touch.id] = touch
        }

        this.emit(event, { touches: Object.values(this.touches), changedTouches: [touch] })
    }
    onVersion(buff) {
        return `${buff[0]}.${buff[1]}.${buff[2]}`
    }
    // Display the current framebuffer
    refresh(id) {
        const displayInfo = DISPLAYS[id]
        return this.send(HEADERS.DRAW, displayInfo.id, { track: true })
    }
    send(action, data = Buffer.alloc(0), { track = false } = {}) {
        if (!this.connection || !this.connection.isReady()) return
        this.transactionID = (this.transactionID + 1) % 256
        // Skip transaction ID's of zero since the device seems to ignore them
        if (this.transactionID === 0) this.transactionID++
        const header = Buffer.alloc(3)
        header.writeUInt16BE(action)
        header[2] = this.transactionID
        const packet = Buffer.concat([header, data])
        this.connection.send(packet)
        if (track) {
            return new Promise(res => {
                this.pendingTransactions[this.transactionID] = res
            })
        }
    }
    setBrightness(value) {
        const byte = Math.max(0, Math.min(MAX_BRIGHTNESS, Math.round(value * MAX_BRIGHTNESS)))
        this.send(HEADERS.SET_BRIGHTNESS, Buffer.from([byte]))
    }
    setButtonColor({ id, color }) {
        const key = Object.keys(BUTTONS).find(k => BUTTONS[k] === id)
        if (!key) throw new Error(`Invalid button ID: ${id}`)
        const [r, g, b] = rgba(color)
        const data = Buffer.from([key, r, g, b])
        this.send(HEADERS.SET_COLOR, data)
    }
    vibrate(pattern = HAPTIC.SHORT) {
        this.send(HEADERS.SET_VIBRATION, Buffer.from([pattern]))
    }
}

module.exports = LoupedeckDevice