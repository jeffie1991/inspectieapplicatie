<template>
  <div class="map-canvas" ref="canvasContainer">
    <svg
      ref="svgOverlay"
      class="overlay"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @click="onClick"
    >
      <g v-for="shape in shapes" :key="shape.id">
        <polygon
          v-if="shape.type === 'polygon'"
          :points="shape.points"
          :class="{ selected: selectedShapes.includes(shape.id) }"
          class="shape"
          @click.stop="selectShape(shape.id, $event)"
        />
        <rect
          v-else-if="shape.type === 'rectangle'"
          :x="shape.x"
          :y="shape.y"
          :width="shape.width"
          :height="shape.height"
          :class="{ selected: selectedShapes.includes(shape.id) }"
          class="shape"
          @click.stop="selectShape(shape.id, $event)"
        />
      </g>
      
      <!-- Current drawing shape -->
      <polygon
        v-if="currentLasso.length > 0 && drawingMode === 'lasso'"
        :points="currentLassoPoints"
        class="drawing-shape"
      />
      <rect
        v-if="currentRect && drawingMode === 'rectangle'"
        :x="currentRect.x"
        :y="currentRect.y"
        :width="currentRect.width"
        :height="currentRect.height"
        class="drawing-shape"
      />
      
      <!-- Selection rectangle -->
      <rect
        v-if="selectionRect"
        :x="selectionRect.x"
        :y="selectionRect.y"
        :width="selectionRect.width"
        :height="selectionRect.height"
        class="selection-rect"
      />
    </svg>
  </div>
</template>

<script>
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { collection, doc, setDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import { useMapStore } from '@/stores/mapStore'

export default {
  name: 'MapCanvas',
  data() {
    return {
      drawingMode: null, // 'lasso', 'rectangle', 'select'
      isDrawing: false,
      currentLasso: [],
      currentRect: null,
      selectionRect: null,
      selectedShapes: [],
      shapes: [],
      ydoc: null,
      yshapes: null,
      provider: null,
      snapThreshold: 10
    }
  },
  computed: {
    currentLassoPoints() {
      return this.currentLasso.map(p => `${p.x},${p.y}`).join(' ')
    }
  },
  mounted() {
    this.initYjs()
    this.setupEventListeners()
  },
  beforeUnmount() {
    if (this.provider) {
      this.provider.destroy()
    }
  },
  methods: {
    initYjs() {
      this.ydoc = new Y.Doc()
      this.yshapes = this.ydoc.getArray('shapes')
      
      this.provider = new WebsocketProvider('ws://localhost:1234', 'map-room', this.ydoc)
      
      this.yshapes.observe(this.syncShapes)
      this.syncShapes()
    },
    
    syncShapes() {
      this.shapes = this.yshapes.toArray()
    },
    
    setupEventListeners() {
      document.addEventListener('keydown', this.onKeyDown)
      document.addEventListener('keyup', this.onKeyUp)
    },
    
    onKeyDown(e) {
      if (e.key === 'Escape') {
        this.cancelDrawing()
      }
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault()
        this.undo()
      }
      if (e.ctrlKey && e.key === 'y') {
        e.preventDefault()
        this.redo()
      }
    },
    
    onMouseDown(e) {
      const point = this.getMousePosition(e)
      
      if (this.drawingMode === 'lasso') {
        this.isDrawing = true
        this.currentLasso = [point]
      } else if (this.drawingMode === 'rectangle') {
        this.isDrawing = true
        this.currentRect = { x: point.x, y: point.y, width: 0, height: 0 }
      } else if (e.ctrlKey) {
        this.isDrawing = true
        this.selectionRect = { x: point.x, y: point.y, width: 0, height: 0 }
      }
    },
    
    onMouseMove(e) {
      if (!this.isDrawing) return
      
      const point = this.getMousePosition(e)
      
      if (this.drawingMode === 'lasso') {
        this.currentLasso.push(this.snapToEdge(point))
      } else if (this.drawingMode === 'rectangle') {
        this.currentRect.width = point.x - this.currentRect.x
        this.currentRect.height = point.y - this.currentRect.y
      } else if (this.selectionRect) {
        this.selectionRect.width = point.x - this.selectionRect.x
        this.selectionRect.height = point.y - this.selectionRect.y
      }
    },
    
    onMouseUp(e) {
      if (!this.isDrawing) return
      
      this.isDrawing = false
      
      if (this.drawingMode === 'lasso' && this.currentLasso.length > 2) {
        this.finalizeLasso()
      } else if (this.drawingMode === 'rectangle' && this.currentRect) {
        this.finalizeRectangle()
      } else if (this.selectionRect) {
        this.selectShapesInRect()
        this.selectionRect = null
      }
    },
    
    onClick(e) {
      if (!e.ctrlKey && !e.shiftKey) {
        this.selectedShapes = []
      }
    },
    
    finalizeLasso() {
      const shape = {
        id: Date.now().toString(),
        type: 'polygon',
        points: this.currentLasso.map(p => `${p.x},${p.y}`).join(' '),
        timestamp: Date.now()
      }
      
      this.yshapes.push([shape])
      this.currentLasso = []
      this.saveToFirestore()
    },
    
    finalizeRectangle() {
      const shape = {
        id: Date.now().toString(),
        type: 'rectangle',
        x: this.currentRect.x,
        y: this.currentRect.y,
        width: Math.abs(this.currentRect.width),
        height: Math.abs(this.currentRect.height),
        timestamp: Date.now()
      }
      
      this.yshapes.push([shape])
      this.currentRect = null
      this.saveToFirestore()
    },
    
    selectShape(shapeId, e) {
      if (e.shiftKey) {
        if (this.selectedShapes.includes(shapeId)) {
          this.selectedShapes = this.selectedShapes.filter(id => id !== shapeId)
        } else {
          this.selectedShapes.push(shapeId)
        }
      } else {
        this.selectedShapes = [shapeId]
      }
    },
    
    selectShapesInRect() {
      const rect = this.selectionRect
      this.selectedShapes = this.shapes
        .filter(shape => this.shapeIntersectsRect(shape, rect))
        .map(shape => shape.id)
    },
    
    shapeIntersectsRect(shape, rect) {
      if (shape.type === 'rectangle') {
        return !(shape.x > rect.x + rect.width || 
                 shape.x + shape.width < rect.x ||
                 shape.y > rect.y + rect.height ||
                 shape.y + shape.height < rect.y)
      }
      return false // Simplified for polygons
    },
    
    snapToEdge(point) {
      // Find nearby shape edges and snap to them
      for (const shape of this.shapes) {
        if (shape.type === 'rectangle') {
          const edges = [
            { x: shape.x, y: point.y },
            { x: shape.x + shape.width, y: point.y },
            { x: point.x, y: shape.y },
            { x: point.x, y: shape.y + shape.height }
          ]
          
          for (const edge of edges) {
            if (Math.abs(point.x - edge.x) < this.snapThreshold && 
                Math.abs(point.y - edge.y) < this.snapThreshold) {
              return edge
            }
          }
        }
      }
      return point
    },
    
    getMousePosition(e) {
      const rect = this.$refs.svgOverlay.getBoundingClientRect()
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      }
    },
    
    setDrawingMode(mode) {
      this.drawingMode = mode
      this.cancelDrawing()
    },
    
    cancelDrawing() {
      this.isDrawing = false
      this.currentLasso = []
      this.currentRect = null
      this.selectionRect = null
    },
    
    undo() {
      if (this.yshapes.length > 0) {
        this.yshapes.delete(this.yshapes.length - 1, 1)
        this.saveToFirestore()
      }
    },
    
    redo() {
      // Simplified redo - would need proper history stack
    },
    
    async saveToFirestore() {
      try {
        const geoJson = this.shapesToGeoJSON()
        const docRef = doc(collection(db, 'maps'), 'current-map')
        await setDoc(docRef, {
          geoJson,
          metadata: {
            lastModified: Date.now(),
            shapeCount: this.shapes.length
          }
        })
      } catch (error) {
        console.error('Error saving to Firestore:', error)
      }
    },
    
    shapesToGeoJSON() {
      return {
        type: 'FeatureCollection',
        features: this.shapes.map(shape => ({
          type: 'Feature',
          geometry: shape.type === 'rectangle' 
            ? {
                type: 'Polygon',
                coordinates: [[
                  [shape.x, shape.y],
                  [shape.x + shape.width, shape.y],
                  [shape.x + shape.width, shape.y + shape.height],
                  [shape.x, shape.y + shape.height],
                  [shape.x, shape.y]
                ]]
              }
            : {
                type: 'Polygon',
                coordinates: [shape.points.split(' ').map(p => {
                  const [x, y] = p.split(',').map(Number)
                  return [x, y]
                })]
              },
          properties: {
            id: shape.id,
            timestamp: shape.timestamp
          }
        }))
      }
    }
  }
}
</script>

<style scoped>
.map-canvas {
  position: relative;
  width: 100%;
  height: 100vh;
}

.overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.shape {
  fill: rgba(66, 165, 245, 0.3);
  stroke: #42a5f5;
  stroke-width: 2;
  cursor: pointer;
}

.shape.selected {
  fill: rgba(255, 193, 7, 0.4);
  stroke: #ffc107;
  stroke-width: 3;
}

.drawing-shape {
  fill: rgba(76, 175, 80, 0.3);
  stroke: #4caf50;
  stroke-width: 2;
  stroke-dasharray: 5,5;
}

.selection-rect {
  fill: rgba(33, 150, 243, 0.1);
  stroke: #2196f3;
  stroke-width: 1;
  stroke-dasharray: 3,3;
}
</style>