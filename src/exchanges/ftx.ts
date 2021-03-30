import { Trade } from '@/services/aggregatorService'
import Exchange from './exchangeAbstract'

export default class extends Exchange {
  id = 'FTX'
  protected endpoints = { PRODUCTS: 'https://ftx.com/api/markets' }

  getUrl() {
    return `wss://ftx.com/ws/`
  }

  formatProducts(data) {
    return data.result.map(product => product.name)
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async subscribe(api, pair) {
    if (!super.subscribe.apply(this, [api, pair])) {
      return
    }

    api.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'trades',
        market: pair
      })
    )
  }

  /**
   * Sub
   * @param {WebSocket} api
   * @param {string} pair
   */
  async unsubscribe(api, pair) {
    if (!super.unsubscribe.apply(this, [api, pair])) {
      return
    }

    api.send(
      JSON.stringify({
        op: 'unsubscribe',
        channel: 'trades',
        market: pair
      })
    )
  }

  onMessage(event, api) {
    const json = JSON.parse(event.data)

    if (!json || !json.data || !json.data.length) {
      return
    }

    const trades: Trade[] = []
    const liquidations: Trade[] = []

    for (let i = 0; i < json.data.length; i++) {
      if (json.data[i].liquidation) {
        liquidations.push(json.data[i])
      } else {
        trades.push(json.data[i])
      }
    }

    if (liquidations.length) {
      this.emitLiquidations(api._id, liquidations)
    }

    if (trades.length) {
      this.emitTrades(api._id, trades)
    }

    return true
  }

  onApiBinded(api) {
    this.startKeepAlive(api, { op: 'ping' }, 15000)
  }

  onApiUnbinded(api) {
    this.stopKeepAlive(api)
  }
}