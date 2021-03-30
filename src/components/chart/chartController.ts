import { formatRgb, toRgb } from 'color-fns'
import { MAX_BARS_PER_CHUNKS } from '../../utils/constants'
import { formatAmount, formatTime, getHms, setValueByDotNotation } from '../../utils/helpers'
import { defaultChartOptions, defaultPlotsOptions, defaultSerieOptions } from './chartOptions'
import store from '../../store'
import * as seriesUtils from './serieUtils'
import * as TV from 'lightweight-charts'
import ChartCache, { Chunk } from './chartCache'
import SerieTranspiler from './serieTranspiler'
import dialogService from '../../services/dialogService'
import SerieDialog from './SerieDialog.vue'
import { defaultChartSeries } from './chartSeries'
import { Trade } from '@/services/aggregatorService'

export interface Bar {
  vbuy?: number
  vsell?: number
  cbuy?: number
  csell?: number
  lbuy?: number
  lsell?: number
  exchange?: string
  pair?: string
  timestamp?: number
  open?: number
  high?: number
  low?: number
  close?: number
  empty?: boolean
}

export interface TimeRange {
  from: number
  to: number
}

export interface OHLC {
  open: number
  high: number
  low: number
  close: number
}

export type SerieAdapter = (
  renderer: Renderer,
  functions: SerieInstruction,
  variables: SerieInstruction,
  options: TV.SeriesOptions<any>,
  seriesUtils: any
) => OHLC | number | { value: number }

export type SerieTranspilationOutputType = 'ohlc' | 'value' | 'custom'

export interface ActiveSerie {
  enabled: boolean
  id: string
  type: string
  input: string
  options: any
  model: SerieTranspilationResult
  adapter: SerieAdapter
  api: TV.ISeriesApi<any>
}

export interface SerieTranspilationResult {
  output: string
  type: SerieTranspilationOutputType
  variables: SerieInstruction[]
  functions: SerieInstruction[]
  exchanges?: string[]
  references?: string[]
}

export interface SerieInstruction {
  name: string
  type: string
  arg?: string | number
  state?: any
}

export interface Renderer {
  timestamp: number
  bar: Bar
  sources: { [name: string]: Bar }
  series: { [id: string]: RendererSerieData }
  empty?: boolean
}

interface RendererSerieData {
  value: number
  point?: any
  variables: SerieInstruction[]
  functions: SerieInstruction[]
}

export default class ChartController {
  chartInstance: TV.IChartApi
  chartElement: HTMLElement
  activeSeries: ActiveSerie[] = []
  activeRenderer: Renderer
  activeChunk: Chunk
  renderedRange: TimeRange
  queuedTrades: Trade[] = []
  chartCache: ChartCache
  serieTranspiler: SerieTranspiler
  preventRender: boolean
  panPrevented: boolean

  private _releaseQueueInterval: number
  private _releasePanTimeout: number
  private _preventImmediateRender: boolean

  constructor() {
    this.chartCache = new ChartCache()
    this.serieTranspiler = new SerieTranspiler()
  }

  createChart(containerElement, chartDimensions) {
    console.log(`[chart/controller] create chart`)

    let chartColor

    if (store.state.settings.chartColor) {
      chartColor = store.state.settings.chartColor
    } else {
      chartColor = store.state.settings.chartTheme === 'light' ? '#111111' : '#f6f6f6'
    }

    const options = Object.assign({}, defaultChartOptions, chartDimensions)

    const chartColorOptions = this.getChartColorOptions(chartColor)

    for (const prop in chartColorOptions) {
      Object.assign(options[prop], chartColorOptions[prop])
    }

    this.chartInstance = TV.createChart(containerElement, options)
    this.chartElement = containerElement

    this.addEnabledSeries()
  }

  /**
   * remove series, destroy this.chartInstance and cancel related events1
   */
  removeChart() {
    console.log(`[chart/controller] remove chart`)

    if (!this.chartInstance) {
      return
    }

    while (this.activeSeries.length) {
      this.removeSerie(this.activeSeries[0])
    }

    this.chartInstance.remove()

    this.chartInstance = null
  }

  /**
   * Get active serie by id
   * @returns {ActiveSerie} serie
   */
  getSerie(id: string): ActiveSerie {
    for (let i = 0; i < this.activeSeries.length; i++) {
      if (this.activeSeries[i].id === id) {
        return this.activeSeries[i]
      }
    }
  }

  /**
   * Update one serie's option
   * @param {Object} obj vuex store payload
   * @param {string} obj.id serie id
   * @param {string} obj.key option key
   * @param {any} obj.value serie id
   */
  setSerieOption({ id, key, value }) {
    const serie = this.getSerie(id)

    if (!serie || serie.enabled === false) {
      return
    }

    let firstKey = key

    if (key.indexOf('.') !== -1) {
      const path = key.split('.')
      setValueByDotNotation(serie.options, path, value)
      firstKey = path[0]
    } else {
      serie.options[key] = value
    }

    serie.api.applyOptions({
      [firstKey]: serie.options[firstKey]
    })

    const noRedrawOptions = [/priceFormat/i, /scaleMargins/i, /color/i, /^linetype$/i, /width/i, /style$/i, /visible$/i]

    for (let i = 0; i < noRedrawOptions.length; i++) {
      if (noRedrawOptions[i] === firstKey || (noRedrawOptions[i] instanceof RegExp && noRedrawOptions[i].test(firstKey))) {
        return
      }
    }

    this.redrawSerie(id)
  }

  /**
   * Rebuild the whole serie
   * @param {string} id serie id
   */
  rebuildSerie(id) {
    this.removeSerie(this.getSerie(id))

    if (this.addSerie(id)) {
      this.redrawSerie(id)
    }
  }

  /**
   * Redraw one specific serie (and the series it depends on)
   * @param {string} id
   */
  redrawSerie(id) {
    let bars = []

    for (const chunk of this.chartCache.chunks) {
      if (chunk.rendered) {
        bars = bars.concat(chunk.bars)
      }
    }

    const series = this.getSeriesDependances(this.getSerie(id))

    series.push(id)

    this.renderBars(bars, series)
  }

  getVisibleRange() {
    const visibleRange = this.chartInstance.timeScale().getVisibleRange() as TimeRange

    if (!visibleRange) {
      return visibleRange
    }

    const timezoneOffset = store.state.settings.timezoneOffset / 1000

    visibleRange.from -= timezoneOffset
    visibleRange.to -= timezoneOffset

    return visibleRange
  }

  /**
   * Redraw
   * @param
   */
  redraw() {
    this.renderVisibleChunks()
  }

  /**
   * Add all enabled series
   */
  addEnabledSeries() {
    for (const id in store.state.settings.series) {
      if (store.state.settings.series[id].enabled === false) {
        continue
      }

      this.addSerie(id)
    }
  }

  /**
   * get series that depends on this serie
   * @param {ActiveSerie} serie
   * @returns {string[]} id of series
   */
  getSeriesDependendingOn(serie) {
    const series = []

    for (let i = 0; i < this.activeSeries.length; i++) {
      const serieCompare = this.activeSeries[i]

      if (serieCompare.id === serie.id) {
        continue
      }

      if (this.isSerieReferencedIn(serie, serieCompare)) {
        series.push(serieCompare.id)
      }
    }

    return series
  }

  /**
   * get dependencies of serie
   * @param {ActiveSerie} serie
   * @returns {string[]} id of series
   */
  getSeriesDependances(serie) {
    return serie.model.references
  }

  /**
   * is serieA referenced in serieB
   * @param {ActiveSerie} serieA
   * @param {ActiveSerie} serieB
   * @returns {boolean}
   */
  isSerieReferencedIn(serieA, serieB) {
    const functionString = serieB.input.toString()
    const reg = new RegExp(`bar\\.series\\.${serieA.id}\\.`, 'g')

    return !!functionString.match(reg)
  }

  /**
   * register serie and create serie api12
   * @param {string} serieId serie id
   * @returns {boolean} success if true
   */
  addSerie(id) {
    const serieSettings = store.state.settings.series[id] || {}
    const defaultSerieSettings = defaultChartSeries[id] || {}
    const serieType = serieSettings.type || defaultSerieSettings.type

    if (!serieType) {
      throw new Error('unknown-serie-type')
    }

    const serieOptions = Object.assign(
      {},
      defaultSerieOptions,
      defaultPlotsOptions[serieType] || {},
      defaultSerieSettings.options || {},
      serieSettings.options || {}
    )

    const serieInput = serieSettings.input || defaultSerieSettings.input

    /* if (id === 'price' && !serieOptions.title) {
      serieOptions.title = serieSettings.name = store.state.app.pairs.join('+')
    } */

    console.info(`[chart/addSerie] adding ${id}`)
    console.info(`\t-> TYPE: ${serieType}`)

    const serie: ActiveSerie = {
      id,
      type: serieType,
      input: serieInput,
      options: serieOptions,
      enabled: false,
      model: null,
      api: null,
      adapter: null
    }

    store.commit('app/ENABLE_SERIE', id)

    if (!this.prepareSerie(serie)) {
      return
    }

    const apiMethodName = 'add' + (serieType.charAt(0).toUpperCase() + serieType.slice(1)) + 'Series'

    serie.api = this.chartInstance[apiMethodName](serieOptions)

    if (serieOptions.scaleMargins && serieOptions.priceScaleId) {
      serie.api.applyOptions({
        scaleMargins: serieOptions.scaleMargins
      })
    }

    this.activeSeries.push(serie)

    this.bindSerie(serie, this.activeRenderer)

    return true
  }

  prepareSerie(serie) {
    console.info(`[chart/prepareSerie] preparing serie "${serie.id}"\n\t-> ${serie.input}\n...`)

    try {
      const transpilationResult = this.serieTranspiler.transpile(serie)
      const { functions, variables, references } = this.serieTranspiler.transpile(serie)
      let { output, type } = transpilationResult

      console.info(`[chart/prepareSerie] success!`)
      console.log(`\t-> ${output}`)
      console.log(`\t ${variables.length} variable(s)`)
      console.log(`\t ${functions.length} function(s)`)
      console.log(`\t ${references.length} references(s)`)

      store.commit('app/SET_SERIE_ERROR', {
        id: serie.id,
        error: null
      })

      if (type === 'ohlc' && serie.type !== 'candlestick' && serie.type !== 'bar') {
        output += '.close'
        type = 'value'
      } else if (type === 'value' && (serie.type === 'candlestick' || serie.type === 'bar')) {
        throw new Error('code output is a single value but ohlc object ({open, high, low, close}) was expected')
      }

      serie.model = {
        output,
        type,
        functions,
        references,
        variables
      }

      return true
    } catch (error) {
      console.error(`[chart/prepareSerie] transpilation failed`)
      console.error(`\t->`, error)

      store.commit('app/SET_SERIE_ERROR', {
        id: serie.id,
        error: error.message
      })

      if (!dialogService.isDialogOpened('serie')) {
        dialogService.open(
          SerieDialog,
          {
            id: serie.id
          },
          'serie'
        )
      }

      return false
    }
  }

  /**
   *
   * @param {ActiveSerie} serie
   * @param {Renderer} renderer
   * @returns
   */
  bindSerie(serie, renderer) {
    if (!renderer || typeof renderer.series[serie.id] !== 'undefined' || !serie.model) {
      return
    }

    const { functions, variables } = JSON.parse(JSON.stringify(serie.model))

    this.serieTranspiler.updateInstructionsArgument(functions)

    console.log(`[chart/bindSerie] binding ${serie.id} ...`)

    renderer.series[serie.id] = {
      value: null,
      point: null,
      functions,
      variables
    }

    serie.adapter = this.serieTranspiler.getAdapter(serie.model.output)
    serie.outputType = serie.model.type

    /*let priority = 0

    for (const reference of serie.model.references) {
      
    }*/

    return serie
  }

  /**
   * Detach serie from renderer
   * @param {ActiveSerie} serie
   * @param {Renderer} renderer
   */
  unbindSerie(serie, renderer) {
    if (!renderer || typeof renderer.series[serie.id] === 'undefined') {
      return
    }

    delete renderer.series[serie.id]
  }

  /**
   * Derender serie
   * if there is series depending on this serie, they will be also removed
   * @param {ActiveSerie} serie
   */
  removeSerie(serie) {
    if (!serie) {
      return
    }

    // remove from chart instance (derender)
    this.chartInstance.removeSeries(serie.api)

    // unbind from activebar (remove serie meta data like sma memory etc)
    this.unbindSerie(serie, this.activeRenderer)

    // update store (runtime prop)
    store.commit('app/DISABLE_SERIE', serie.id)

    // recursive remove of dependent series
    /* for (let dependentId of this.getSeriesDependendingOn(serie)) {
      this.removeSerie(this.getSerie(dependentId))
    } */

    // remove from active series model
    this.activeSeries.splice(this.activeSeries.indexOf(serie), 1)
  }

  /**
   * toggle serie on or off
   * if turn on it will try redraw serie
   * @param {Object} obj vuex store payload
   * @param {string} obj.id serie id
   * @param {boolean} obj.value true = enable serie, false = disable
   */
  toggleSerie(id) {
    let enabled = true

    if (!store.state.settings.series[id] || store.state.settings.series[id].enabled === false) {
      enabled = false
    }

    if (!enabled) {
      this.removeSerie(this.getSerie(id))
    } else {
      if (this.addSerie(id)) {
        this.redrawSerie(id)
      }
    }
  }

  /**
   * clear rendered stuff
   */
  clearChart() {
    console.log(`[chart/controller] clear chart (all series emptyed)`)

    this.preventPan()

    for (const serie of this.activeSeries) {
      this.clearSerie(serie)
    }

    this.renderedRange.from = this.renderedRange.to = null
  }

  /**
   * clear active data
   */
  clearData() {
    console.log(`[chart/controller] clear data (activeRenderer+activeChunk+queuedTrades1)`)

    this.activeRenderer = null
    this.activeChunk = null
    this.queuedTrades.splice(0, this.queuedTrades.length)
  }

  /**
   * clear data and rendered stuff
   */
  clear() {
    console.log(`[chart/controller] clear all (cache+activedata+chart)`)

    this.chartCache.clear()
    this.clearData()
    this.clearChart()
  }

  /**
   * clear everything
   */
  destroy() {
    console.log(`[chart/controller] destroy`)

    this.chartCache.clear()
    this.clearData()
    this.clearChart()
    this.removeChart()
    this.clearQueue()
  }

  /**
   * @param {ActiveSerie} serie serie to clear
   */
  clearSerie(serie) {
    serie.api.setData([])
  }

  /**
   * start queuing next trades
   */
  setupQueue() {
    if (this._releaseQueueInterval || !store.state.settings.chartRefreshRate) {
      return
    }

    console.log(`[chart/controller] setup queue (${getHms(store.state.settings.chartRefreshRate)})`)

    this._releaseQueueInterval = setInterval(() => {
      if (!this._preventImmediateRender) {
        this.releaseQueue()
      }
    }, store.state.settings.chartRefreshRate)
  }

  /**
   * release queue and stop queuing next trades
   */
  clearQueue() {
    if (!this._releaseQueueInterval) {
      return
    }

    console.log(`[chart/controller] clear queue`)

    clearInterval(this._releaseQueueInterval)
    delete this._releaseQueueInterval

    this.releaseQueue()
  }

  /**
   * pull trades from queue and render them immediately
   */
  releaseQueue() {
    if (!this.queuedTrades.length || this.preventRender) {
      return
    }

    this.renderRealtimeTrades(this.queuedTrades)
    this.queuedTrades.splice(0, this.queuedTrades.length)
  }

  /**
   * unlock render, will release queue on next queueInterval
   */
  unlockRender() {
    this.preventRender = false
  }

  /**
   * temporarily disable render to avoid issues
   */
  lockRender() {
    this.preventRender = true
  }

  /**
   * push a set of trades to queue in order to render them later
   * @param {Trades[]} trades
   */
  queueTrades(trades) {
    Array.prototype.push.apply(this.queuedTrades, trades)
  }

  /**
   * take a set of trades, group them into bars while using activeRenderer for reference and render them
   * also cache finished bar
   * @param {Trade[]} trades trades to render
   */
  renderRealtimeTrades(trades) {
    const formatedBars = []

    if (!trades.length) {
      return
    }

    let i = 0

    for (i; i < trades.length; i++) {
      const trade = trades[i]
      const identifier = trade.exchange + trade.pair
      const timestamp = Math.floor(trade.timestamp / 1000 / store.state.settings.timeframe) * store.state.settings.timeframe

      if (!this.activeRenderer || this.activeRenderer.timestamp < timestamp) {
        if (this.activeRenderer) {
          if (!this.activeChunk || (this.activeChunk.to < this.activeRenderer.timestamp && this.activeChunk.bars.length >= MAX_BARS_PER_CHUNKS)) {
            if (!this.activeChunk) {
              console.log(`[chart/renderRealtimeTrades] formatbar require require active chunk`)
            } else {
              console.log(`[chart/renderRealtimeTrades] current active chunk is too large (${this.activeChunk.bars.length} bars)`)
            }

            if (!this.activeChunk && this.chartCache.cacheRange.to === this.activeRenderer.timestamp) {
              this.chartCache.chunks[this.chartCache.chunks.length - 1].active = true
              this.activeChunk = this.chartCache.chunks[this.chartCache.chunks.length - 1]
              this.activeChunk.active = true
              console.log(`\t-> set last chunk as activeChunk (same timestamp, ${this.activeChunk.bars.length} bars)`)
            } else {
              if (this.activeChunk) {
                console.log(
                  `\t-> mark current active chunk as inactive (#${this.chartCache.chunks.indexOf(this.activeChunk)} | FROM: ${formatTime(
                    this.activeChunk.from
                  )} | TO: ${formatTime(this.activeChunk.to)})\n\t-> then create new chunk as activeChunk`
                )
                this.activeChunk.active = false
              }

              this.activeChunk = this.chartCache.saveChunk({
                from: this.activeRenderer.timestamp,
                to: this.activeRenderer.timestamp,
                active: true,
                rendered: true,
                bars: []
              })

              console.log(
                `[chart/renderRealtimeTrades] create new active chunk (#${this.chartCache.chunks.indexOf(this.activeChunk)} | FROM: ${formatTime(
                  this.activeChunk.from
                )} | TO: ${formatTime(this.activeChunk.to)})`
              )
            }
          }

          if (!this.activeRenderer.bar.empty) {
            formatedBars.push(this.computeBar(this.activeRenderer))
          }

          // feed activeChunk with active bar exchange snapshot
          for (const source in this.activeRenderer.sources) {
            if (!this.activeRenderer.sources[source].empty) {
              this.activeChunk.bars.push(this.cloneSourceBar(this.activeRenderer.sources[source], this.activeRenderer.timestamp))
            }
          }

          this.activeChunk.to = this.chartCache.cacheRange.to = this.activeRenderer.timestamp

          if (this.renderedRange.to < this.activeRenderer.timestamp) {
            this.renderedRange.to = this.activeRenderer.timestamp
          }

          this.nextBar(timestamp, this.activeRenderer)
        } else {
          this.activeRenderer = this.createRenderer(timestamp)
        }

        this.preventPan()
      }

      const amount = trade.price * trade.size

      if (!this.activeRenderer.sources[identifier]) {
        this.activeRenderer.sources[identifier] = {
          exchange: trade.exchange,
          close: +trade.price
        }

        this.resetBar(this.activeRenderer.sources[identifier])
      }

      this.activeRenderer.sources[identifier].empty = false

      const isActive = store.state.app.activeExchanges[identifier]

      if (trade.liquidation) {
        this.activeRenderer.sources[identifier]['l' + trade.side] += amount

        if (isActive) {
          this.activeRenderer.bar['l' + trade.side] += amount
          this.activeRenderer.bar.empty = false
        }

        continue
      }

      this.activeRenderer.sources[identifier].high = Math.max(this.activeRenderer.sources[identifier].high, +trade.price)
      this.activeRenderer.sources[identifier].low = Math.min(this.activeRenderer.sources[identifier].low, +trade.price)
      this.activeRenderer.sources[identifier].close = +trade.price

      this.activeRenderer.sources[identifier]['c' + trade.side]++
      this.activeRenderer.sources[identifier]['v' + trade.side] += amount

      if (isActive) {
        this.activeRenderer.bar['v' + trade.side] += amount
        this.activeRenderer.bar['c' + trade.side]++
        this.activeRenderer.bar.empty = false
      }
    }

    if (!this.activeRenderer.bar.empty) {
      formatedBars.push(this.computeBar(this.activeRenderer))

      if (this.renderedRange.to < this.activeRenderer.timestamp) {
        this.renderedRange.to = this.activeRenderer.timestamp
      }
    }

    for (let i = 0; i < formatedBars.length; i++) {
      this.updateBar(formatedBars[i])
    }
  }

  /**
   * create a new object from an existing bar
   * to avoid reference when storing finished bar data to cache
   * @param {Bar} bar do copy
   * @param {number} [timestamp] apply timestamp to returned bar
   */
  cloneSourceBar(sourceBar, timestamp?: number): Bar {
    return {
      pair: sourceBar.pair,
      exchange: sourceBar.exchange,
      timestamp: timestamp || sourceBar.timestamp,
      open: sourceBar.open,
      high: sourceBar.high,
      low: sourceBar.low,
      close: sourceBar.close,
      vbuy: sourceBar.vbuy,
      vsell: sourceBar.vsell,
      cbuy: sourceBar.cbuy,
      csell: sourceBar.csell,
      lbuy: sourceBar.lbuy,
      lsell: sourceBar.lsell
    }
  }

  /**
   * Render a set of bars
   *
   * @param {Bar[]} bars bars to render
   * @param {string[]} [series] render only theses series
   */
  renderBars(bars, series) {
    console.log(`[chart/controller] render bars`, '(', series ? 'specific serie(s): ' + series.join(',') : 'all series', ')', bars.length, 'bar(s)')

    if (!bars.length) {
      return
    }

    const computedSeries = {}
    let from = null
    let to = null

    let temporaryRenderer

    for (let i = 0; i <= bars.length; i++) {
      const bar = bars[i]

      if (!bar || !temporaryRenderer || bar.timestamp > temporaryRenderer.timestamp) {
        if (temporaryRenderer && temporaryRenderer.bar.hasData) {
          if (from === null) {
            from = temporaryRenderer.timestamp
          }

          to = temporaryRenderer.timestamp

          const computedBar = this.computeBar(temporaryRenderer, series)

          for (const id in computedBar) {
            if (typeof computedSeries[id] === 'undefined') {
              computedSeries[id] = []
            }

            computedSeries[id].push(computedBar[id])
          }
        }

        if (!bar) {
          break
        }

        if (temporaryRenderer) {
          this.nextBar(bar.timestamp, temporaryRenderer)
        } else {
          temporaryRenderer = this.createRenderer(bar.timestamp, series)
        }
      }

      if (!store.state.app.activeExchanges[bar.exchange]) {
        continue
      }

      temporaryRenderer.bar.hasData = true
      temporaryRenderer.bar.vbuy += bar.vbuy
      temporaryRenderer.bar.vsell += bar.vsell
      temporaryRenderer.bar.cbuy += bar.cbuy
      temporaryRenderer.bar.csell += bar.csell
      temporaryRenderer.bar.lbuy += bar.lbuy
      temporaryRenderer.bar.lsell += bar.lsell

      temporaryRenderer.exchanges[bar.exchange] = this.cloneSourceBar(bar)
    }

    if (!series) {
      this.clearChart()

      if (!bars.length) {
        this.renderedRange.from = this.renderedRange.to = null
      } else {
        this.renderedRange.from = from
        this.renderedRange.to = to
      }
    }

    this.replaceData(computedSeries)

    if (this.activeRenderer) {
      for (const id in temporaryRenderer.series) {
        this.activeRenderer.series[id] = temporaryRenderer.series[id]
      }
    } else {
      this.activeRenderer = temporaryRenderer
    }
  }

  /**
   * Renders chunks that collides with visible range
   */
  renderVisibleChunks() {
    if (!this.chartCache.chunks.length || !this.chartInstance) {
      return
    }

    const visibleRange = this.getVisibleRange()
    const visibleLogicalRange = this.chartInstance.timeScale().getVisibleLogicalRange()

    let from = null

    if (visibleRange) {
      console.log('[chart/renderVisibleChunks] VisibleRange: ', `from: ${formatTime(visibleRange.from)} -> to: ${formatTime(visibleRange.to)}`)

      from = visibleRange.from

      if (visibleLogicalRange.from < 0) {
        from += store.state.settings.timeframe * visibleLogicalRange.from

        console.log(
          '[chart/renderVisibleChunks] Ajusted visibleRange using visibleLogicalRange: ',
          `bars offset: ${visibleLogicalRange.from} === from: ${formatTime(from)}`
        )
      }
    }

    const selection = ['------------------------']
    const bars = this.chartCache.chunks
      .filter(c => {
        c.rendered = !visibleRange || c.to > from - store.state.settings.timeframe * 20
        selection.push(
          `${c.rendered ? '[selected] ' : ''} #${this.chartCache.chunks.indexOf(c)} | FROM: ${formatTime(c.from)} | TO: ${formatTime(
            c.to
          )} (${formatAmount(c.bars.length)} bars)`
        )

        return c.rendered
      })
      .reduce((bars, chunk) => bars.concat(chunk.bars), [])
    selection.push('------------------------')
    console.log(selection.join('\n') + '\n')
    this.renderBars(bars, null)
  }

  /**
   * Attach marker to serie
   * @param {ActiveSerie} serie serie
   */
  setMarkers(serie, marker) {
    if (!serie.markers) {
      serie.markers = []
    }

    for (let i = serie.markers.length - 1; i >= 0; i--) {
      if (serie.markers[i].time === marker.time) {
        serie.markers.splice(i, 1)
        break
      }
    }

    serie.markers.push(marker)

    setTimeout(() => {
      serie.api.setMarkers(serie.markers)
    }, 100)
  }

  /**
   * disable "fetch on pan" until current operation (serie.update / serie.setData) is finished
   */
  preventPan() {
    if (this.panPrevented) {
      return
    }

    const delay = 1000

    // console.info(`[chart/controller] prevent pan for next ${getHms(delay)}`)

    if (typeof this._releasePanTimeout !== 'undefined') {
      clearTimeout(this._releasePanTimeout)
    }

    this.panPrevented = true

    this._releasePanTimeout = window.setTimeout(() => {
      if (!this.panPrevented) {
        // console.warn(`[chart/controller] pan already released (before timeout fired)`)
      } else {
        // console.info(`[chart/controller] pan released (by timeout)`)

        this.panPrevented = false
      }
    }, delay)
  }

  /**
   * replace whole chart with a set of bars
   * @param {Bar[]} bars bars to render
   */
  replaceData(computedSeries) {
    this.preventPan()

    for (const serie of this.activeSeries) {
      if (computedSeries[serie.id] && computedSeries[serie.id].length) {
        serie.api.setData(computedSeries[serie.id])
      }
    }
  }

  /**
   * update last or add new bar to this.chartInstance
   * @param {Bar} bar
   */
  updateBar(bar) {
    for (const serie of this.activeSeries) {
      if (bar[serie.id]) {
        serie.api.update(bar[serie.id])
      }
    }
  }

  /**
   * Process bar data and compute series values for this bar
   * @param {Renderer} renderer
   * @param {string[]} series
   */
  computeBar(renderer, series?: string[]) {
    const points = {}

    const time = renderer.timestamp + store.state.settings.timezoneOffset / 1000

    for (const serie of this.activeSeries) {
      if (series && series.indexOf(serie.id) === -1) {
        continue
      }

      const serieData = renderer.series[serie.id]

      serieData.point = serie.adapter(renderer, serieData.functions, serieData.variables, serie.options, seriesUtils)

      if (serie.model.type === 'value') {
        serieData.value = serieData.point
        points[serie.id] = { time, value: serieData.point }
      } else if (serie.model.type === 'ohlc') {
        serieData.value = serieData.point.close
        points[serie.id] = { time, open: serieData.point.open, high: serieData.point.high, low: serieData.point.low, close: serieData.point.close }
      } else if (serie.model.type === 'custom') {
        serieData.value = serieData.point.value
        points[serie.id] = { time, ...serieData.point }
      }

      if (isNaN(serieData.value)) {
        this.unbindSerie(serie, this.activeRenderer)

        store.commit('app/SET_SERIE_ERROR', {
          id: serie.id,
          error: `${serie.id} is NaN`
        })

        if (!dialogService.isDialogOpened('serie')) {
          dialogService.open(
            SerieDialog,
            {
              id: serie.id
            },
            'serie'
          )
        }

        continue
      } else if (serieData.value === null || (serie.type === 'histogram' && serieData.value === 0)) {
        delete points[serie.id]
      }
    }

    return points
  }

  /**
   * Create empty renderer
   * @param {number} timestamp start timestamp
   * @param {string[]} series series to bind
   */
  createRenderer(firstBarTimestamp, series?: string[]) {
    const renderer: Renderer = {
      timestamp: firstBarTimestamp,
      series: {},
      sources: {},

      bar: {
        vbuy: 0,
        vsell: 0,
        cbuy: 0,
        csell: 0,
        lbuy: 0,
        lsell: 0
      }
    }

    for (const serie of this.activeSeries) {
      if (series && series.indexOf(serie.id) === -1) {
        continue
      }

      this.bindSerie(serie, renderer)
    }

    return renderer
  }

  /**
   * prepare renderer for next bar
   * @param {number} timestamp timestamp of the next bar
   * @param {Renderer?} renderer bar to use as reference
   */
  nextBar(timestamp, renderer?: Renderer) {
    if (!renderer.bar.empty) {
      for (let i = 0; i < this.activeSeries.length; i++) {
        const rendererSerieData = renderer.series[this.activeSeries[i].id]

        if (!rendererSerieData) {
          continue
        }

        for (let f = 0; f < rendererSerieData.functions.length; f++) {
          const instruction = rendererSerieData.functions[f]

          if (instruction.type === 'average_function') {
            instruction.state.points.push(instruction.state.output)
            instruction.state.sum += instruction.state.output
            instruction.state.count++

            if (instruction.state.count > instruction.arg) {
              instruction.state.sum -= instruction.state.points.shift()
              instruction.state.count--
            }
          } else if (instruction.type === 'ohlc') {
            instruction.state.open = instruction.state.close
            instruction.state.high = instruction.state.close
            instruction.state.low = instruction.state.close
          }
        }

        for (let v = 0; v < rendererSerieData.variables.length; v++) {
          const instruction = rendererSerieData.variables[v]

          if (instruction.type === 'array') {
            instruction.state.unshift(instruction.state[0])

            if (instruction.state.length > instruction.arg) {
              instruction.state.pop()
            }
          }
        }
      }
    }

    renderer.timestamp = timestamp

    this.resetRendererBar(renderer)
  }

  /**
   * @param {Renderer} bar bar to clear for next timestamp
   */
  resetRendererBar(renderer) {
    renderer.bar = {
      vbuy: 0,
      vsell: 0,
      cbuy: 0,
      csell: 0,
      lbuy: 0,
      lsell: 0,
      hasData: false
    }

    if (typeof renderer.exchanges !== 'undefined') {
      for (const exchange in renderer.exchanges) {
        this.resetBar(renderer.exchanges[exchange])
      }
    }
  }

  /**
   *
   * @param {Bar} bar
   */
  resetBar(bar: Bar) {
    bar.open = bar.close
    bar.high = bar.close
    bar.low = bar.close
    bar.vbuy = 0
    bar.vsell = 0
    bar.cbuy = 0
    bar.csell = 0
    bar.lbuy = 0
    bar.lsell = 0
    bar.empty = false
  }

  getChartColorOptions(color) {
    const borderColor = formatRgb({ ...toRgb(color), alpha: 0.2 })

    const crossHairColor = store.state.settings.chartTheme === 'light' ? 'rgba(0, 0, 0, .25)' : 'rgba(255, 255, 255, .25)'

    return {
      crosshair: {
        vertLine: {
          color: crossHairColor
        },
        horzLine: {
          color: crossHairColor
        }
      },
      layout: {
        textColor: color,
        borderColor
      },
      priceScale: {
        borderColor
      },
      timeScale: {
        borderColor
      }
    }
  }

  setChartColor(color) {
    this.chartInstance.applyOptions(this.getChartColorOptions(color))
  }
}