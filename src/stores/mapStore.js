import { defineStore } from 'pinia'

export const useMapStore = defineStore('map', {
  state: () => ({
    shapes: [],
    selectedShapes: [],
    drawingMode: null,
    history: [],
    historyIndex: -1
  }),
  
  actions: {
    addShape(shape) {
      this.shapes.push(shape)
      this.addToHistory()
    },
    
    removeShape(shapeId) {
      this.shapes = this.shapes.filter(s => s.id !== shapeId)
      this.addToHistory()
    },
    
    selectShape(shapeId) {
      if (!this.selectedShapes.includes(shapeId)) {
        this.selectedShapes.push(shapeId)
      }
    },
    
    deselectShape(shapeId) {
      this.selectedShapes = this.selectedShapes.filter(id => id !== shapeId)
    },
    
    clearSelection() {
      this.selectedShapes = []
    },
    
    setDrawingMode(mode) {
      this.drawingMode = mode
    },
    
    addToHistory() {
      this.history = this.history.slice(0, this.historyIndex + 1)
      this.history.push(JSON.parse(JSON.stringify(this.shapes)))
      this.historyIndex++
      
      if (this.history.length > 50) {
        this.history.shift()
        this.historyIndex--
      }
    },
    
    undo() {
      if (this.historyIndex > 0) {
        this.historyIndex--
        this.shapes = JSON.parse(JSON.stringify(this.history[this.historyIndex]))
      }
    },
    
    redo() {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++
        this.shapes = JSON.parse(JSON.stringify(this.history[this.historyIndex]))
      }
    }
  }
})