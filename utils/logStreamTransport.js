const Transport = require('winston-transport');
const { EventEmitter } = require('events');

/**
 * A custom Winston transport that emits log events.
 * This allows other parts of the application, like an SSE endpoint,
 * to listen for and broadcast new log messages in real-time.
 */
class StreamTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.emitter = new EventEmitter();
  }

  log(info, callback) {
    setImmediate(() => {
      this.emitter.emit('log', info);
    });
    callback();
  }
}

// Export a single instance to be shared across the application
module.exports = new StreamTransport();