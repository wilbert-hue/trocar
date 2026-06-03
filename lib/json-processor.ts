/**
 * Dynamic JSON Processor
 * Processes any market JSON structure and converts it to ComparisonData format
 */

import type { ComparisonData, DataRecord, Metadata, GeographyDimension, SegmentDimension, SegmentHierarchy } from './types'
import fs from 'fs/promises'
import path from 'path'

interface RawJsonData {
  [geography: string]: {
    [segmentType: string]: {
      [key: string]: any
    }
  }
}

interface YearData {
  [year: string]: number | string | boolean | null | undefined
}

/**
 * Generator function for async path extraction (memory efficient)
 * This version only yields paths that have year data (for value/volume files)
 */
function* extractPathsGenerator(
  obj: any,
  currentPath: string[] = [],
  depth: number = 0
): Generator<{ path: string[]; data?: YearData }> {
  if (depth > 20 || !obj || typeof obj !== 'object') {
    return
  }

  const keys = Object.keys(obj)
  const hasYearData = keys.some(key => /^\d{4}$/.test(key) || key === 'CAGR')
  
  // If this node has year data, yield it (could be a leaf node or an aggregation node)
  if (hasYearData) {
    const yearData: YearData = {}
    keys.forEach(key => {
      if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
        yearData[key] = obj[key]
      }
    })
    yield { path: currentPath, data: yearData }
    
    // IMPORTANT: Don't return here - continue traversing child objects
    // This allows us to extract both aggregation nodes (with year data) AND their child leaf nodes
    // Aggregations have year data at the same level as child objects, so we need to traverse both
  }

  // Continue traversing child objects (non-year, non-metadata keys)
  for (const key of keys) {
    // Skip year keys and metadata keys - we've already processed them above
    if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
      continue
    }
    
    try {
      yield* extractPathsGenerator(obj[key], [...currentPath, key], depth + 1)
    } catch (error) {
      console.error(`Error extracting path at ${currentPath.join(' > ')} > ${key}:`, error)
    }
  }
}

/**
 * Generator function for extracting ALL paths from structure (even empty objects)
 * This is used for segmentation JSON which may have empty objects at leaf nodes
 * IMPORTANT: After aggregations are calculated, parent nodes have year data AND children,
 * so we must continue traversing even when year data is present
 */
function* extractStructurePathsGenerator(
  obj: any,
  currentPath: string[] = [],
  depth: number = 0
): Generator<{ path: string[] }> {
  if (depth > 20 || !obj || typeof obj !== 'object') {
    return
  }

  const keys = Object.keys(obj)
  
  // Check if this is a leaf node (empty object or has year data but no child objects)
  const hasYearData = keys.some(key => /^\d{4}$/.test(key) || key === 'CAGR')
  const isEmptyObject = keys.length === 0
  
  // Check if there are any child objects (non-year, non-metadata keys that are objects)
  const hasChildObjects = keys.some(key => {
    if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
      return false
    }
    const value = obj[key]
    return value && typeof value === 'object' && !Array.isArray(value)
  })
  
  // If it's a leaf node (has year data OR is empty) AND has no child objects, yield the path
  if ((hasYearData || isEmptyObject) && !hasChildObjects) {
    yield { path: currentPath }
    return
  }
  
  // If it has year data but also has child objects, yield this path (it's an aggregation node)
  // but continue traversing to get child paths
  if (hasYearData && hasChildObjects) {
    yield { path: currentPath }
    // Don't return - continue to traverse children
  }

  // Continue traversing for non-leaf nodes (or nodes with both year data and children)
  for (const key of keys) {
    // Skip year keys and metadata keys - we've already processed them above
    if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
      continue
    }
    
    try {
      yield* extractStructurePathsGenerator(obj[key], [...currentPath, key], depth + 1)
    } catch (error) {
      console.error(`Error extracting structure path at ${currentPath.join(' > ')} > ${key}:`, error)
    }
  }
}

/**
 * Async function to collect paths in chunks (yields control periodically)
 */
async function collectPathsAsync(
  generator: Generator<{ path: string[]; data?: YearData }>,
  chunkSize: number = 1000
): Promise<Array<{ path: string[]; data?: YearData }>> {
  const paths: Array<{ path: string[]; data?: YearData }> = []
  let count = 0
  
  for (const path of generator) {
    paths.push(path)
    count++
    
    // Yield control periodically to avoid blocking
    if (count % chunkSize === 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  
  return paths
}

/**
 * Extract years asynchronously (yields control periodically)
 */
async function extractYearsAsync(data: RawJsonData): Promise<number[]> {
  const years = new Set<number>()
  
  const traverse = async (obj: any, depth: number = 0): Promise<void> => {
    if (depth > 15 || !obj || typeof obj !== 'object') return
    
    const keys = Object.keys(obj)
    
    // Check if this object has year keys directly (leaf node)
    const hasYearKeys = keys.some(key => /^\d{4}$/.test(key))
    if (hasYearKeys) {
      // This is a leaf node with year data - extract all year keys
      keys.forEach(key => {
        if (/^\d{4}$/.test(key)) {
          const year = parseInt(key, 10)
          if (year >= 1900 && year <= 2100) {
            years.add(year)
          }
        }
      })
    }
    
    // Continue traversing child objects
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      
      // Skip year keys and metadata - we've already processed them
      if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
        continue
      }
      
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        await traverse(obj[key], depth + 1)
      }
      
      // Yield control every 100 keys
      if (i % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }
  
  try {
    console.log('Extracting years from data structure...')
    const geographies = Object.values(data)
    console.log(`Found ${geographies.length} geographies to traverse`)
    
    for (const geography of geographies) {
      if (geography && typeof geography === 'object') {
        const segmentTypes = Object.values(geography)
        for (const segmentType of segmentTypes) {
          if (segmentType && typeof segmentType === 'object') {
            await traverse(segmentType)
          }
        }
      }
    }
    
    console.log(`Extracted ${years.size} unique years:`, Array.from(years).sort((a, b) => a - b))
  } catch (error) {
    console.error('Error extracting years:', error)
    throw new Error(`Failed to extract years: ${error instanceof Error ? error.message : String(error)}`)
  }
  
  const yearArray = Array.from(years).sort((a, b) => a - b)
  if (yearArray.length === 0) {
    // Log the data structure to help debug
    console.error('No years found. Sample data structure:', JSON.stringify(data, null, 2).substring(0, 1000))
    throw new Error('No valid years found in data. Please ensure your file has year columns (e.g., 2018, 2019, 2020) with data.')
  }
  
  return yearArray
}

/**
 * Determine if a path segment is a geography
 */
function isGeography(segment: string, allGeographies: Set<string>): boolean {
  return allGeographies.has(segment)
}

/**
 * Build segment hierarchy from path
 */
function buildSegmentHierarchy(
  path: string[],
  geographyIndex: number,
  segmentTypeIndex: number
): SegmentHierarchy {
  const segmentParts = path.slice(segmentTypeIndex + 1)
  
  return {
    level_1: segmentParts[0] || '',
    level_2: segmentParts[1] || '',
    level_3: segmentParts[2] || '',
    level_4: segmentParts[3] || '',
    level_5: segmentParts[4] || '',
  }
}

/**
 * Determine segment level (parent or leaf)
 */
function getSegmentLevel(
  path: string[],
  allPaths: Array<{ path: string[] }>,
  segmentTypeIndex: number
): 'parent' | 'leaf' {
  const segmentPath = path.slice(segmentTypeIndex + 1)
  
  // Check if any other path has this as a parent
  const hasChildren = allPaths.some(otherPath => {
    if (otherPath.path.length <= path.length) return false
    const otherSegmentPath = otherPath.path.slice(segmentTypeIndex + 1)
    return otherSegmentPath.slice(0, segmentPath.length).join('|') === segmentPath.join('|')
  })
  
  return hasChildren ? 'parent' : 'leaf'
}

/**
 * Create a path index for fast child lookups
 * Maps parent path strings to arrays of child paths
 */
function createPathIndex(allPaths: Array<{ path: string[] }>): Map<string, Array<{ path: string[] }>> {
  const index = new Map<string, Array<{ path: string[] }>>()
  
  if (!allPaths || allPaths.length === 0) {
    return index
  }
  
  // Group paths by their parent path
  for (const pathObj of allPaths) {
    const path = pathObj.path
    if (path.length === 0) continue
    
    // For each path, add it to its parent's children list
    // Parent is path.slice(0, -1)
    if (path.length > 1) {
      const parentPath = path.slice(0, -1)
      const parentKey = parentPath.join('|')
      
      if (!index.has(parentKey)) {
        index.set(parentKey, [])
      }
      index.get(parentKey)!.push({ path })
    }
  }
  
  return index
}

/**
 * Get ALL children paths for a given parent path
 * This is more comprehensive than just checking if children exist
 * Returns direct children only (path.length === parentPath.length + 1)
 * OPTIMIZED: Uses path index for O(1) lookup instead of O(n) filter
 */
function getAllChildrenPaths(
  parentPath: string[],
  allPaths: Array<{ path: string[] }>,
  pathIndex?: Map<string, Array<{ path: string[] }>>,
  structureData?: RawJsonData,
  valueData?: RawJsonData | null,
  volumeData?: RawJsonData | null
): Array<{ path: string[] }> {
  const children: Array<{ path: string[] }> = []
  
  // Strategy 1: Use path index (fastest - O(1) lookup)
  if (pathIndex) {
    const parentKey = parentPath.join('|')
    const indexedChildren = pathIndex.get(parentKey)
    if (indexedChildren && indexedChildren.length > 0) {
      return indexedChildren
    }
  }
  
  // Strategy 2: Use allPaths with optimized filter (fallback if no index)
  if (allPaths && allPaths.length > 0) {
    const parentKey = parentPath.join('|')
    const parentLength = parentPath.length
    
    // Only check paths that could be children (length check first for early exit)
    for (const otherPath of allPaths) {
      const otherPathArray = otherPath.path
      // Quick length check first
      if (otherPathArray.length !== parentLength + 1) {
        continue
      }
      
      // Check prefix match
      let isChild = true
      for (let i = 0; i < parentLength; i++) {
        if (otherPathArray[i] !== parentPath[i]) {
          isChild = false
          break
        }
      }
      
      if (isChild) {
        children.push({ path: otherPathArray })
      }
    }
    
    if (children.length > 0) {
      return children
    }
  }
  
  // Strategy 2: Navigate through data structures (fallback)
  if (parentPath.length < 2) {
    return []
  }
  
  const geography = parentPath[0]
  const segmentType = parentPath[1]
  const segmentPath = parentPath.slice(2)
  
  // Try structure data first
  let current: any = null
  let found = false
  
  const dataSources = [
    { data: structureData, name: 'structure' },
    { data: valueData, name: 'value' },
    { data: volumeData, name: 'volume' }
  ]
  
  for (const source of dataSources) {
    if (!source.data || found) continue
    
    if (source.data[geography]?.[segmentType]) {
      current = source.data[geography][segmentType]
      found = true
      
      // Navigate through segment path
      for (const segmentKey of segmentPath) {
        if (current && typeof current === 'object' && current[segmentKey] !== undefined) {
          current = current[segmentKey]
        } else {
          found = false
          break
        }
      }
      
      if (found) break
    }
  }
  
  if (!found || !current || typeof current !== 'object') {
    return []
  }
  
  // Extract direct children from current node
  const keys = Object.keys(current)
  for (const key of keys) {
    // Skip year keys, CAGR, and metadata keys
    if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
      continue
    }
    
    const value = current[key]
    // Check if it's a non-null object (not array, not null)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      children.push({ path: [...parentPath, key] })
    }
  }
  
  return children
}

/**
 * Recursively get ALL descendant paths (children, grandchildren, etc.)
 */
function getAllDescendantPaths(
  parentPath: string[],
  allPaths: Array<{ path: string[] }>
): Array<{ path: string[] }> {
  const descendants: Array<{ path: string[] }> = []
  
  if (!allPaths || allPaths.length === 0) {
    return descendants
  }
  
  // Find all paths that start with parentPath
  for (const otherPath of allPaths) {
    // Check if otherPath is a descendant of parentPath
    if (otherPath.path.length <= parentPath.length) {
      continue
    }
    
    // Check if otherPath starts with parentPath (exact prefix match)
    let isDescendant = true
    for (let i = 0; i < parentPath.length; i++) {
      if (otherPath.path[i] !== parentPath[i]) {
        isDescendant = false
        break
      }
    }
    
    if (isDescendant) {
      descendants.push({ path: otherPath.path })
    }
  }
  
  return descendants
}

/**
 * Check if a path has children in the structure or value data, or in the list of all paths
 * Used to infer aggregation level when _level is missing
 * Enhanced version that uses getAllChildrenPaths for more reliable detection
 */
function checkIfPathHasChildren(
  structureData: RawJsonData,
  pathArray: string[],
  valueData?: RawJsonData | null,
  volumeData?: RawJsonData | null,
  allPaths?: Array<{ path: string[] }>,
  pathIndex?: Map<string, Array<{ path: string[] }>>
): boolean {
  try {
    // Use getAllChildrenPaths to get actual children (more reliable)
    const children = getAllChildrenPaths(
      pathArray,
      allPaths || [],
      pathIndex,
      structureData,
      valueData,
      volumeData
    )
    
    return children.length > 0
  } catch (error) {
    console.warn('Error checking if path has children:', error, {
      pathArray,
      hasStructureData: !!structureData,
      hasValueData: !!valueData,
      hasVolumeData: !!volumeData,
      allPathsCount: allPaths?.length || 0
    })
    return false
  }
}

/**
 * Process segment type asynchronously
 */
async function processSegmentTypeAsync(
  structureData: RawJsonData,
  valueData: RawJsonData | null,
  volumeData: RawJsonData | null,
  segmentType: string,
  geographies: string[],
  allYears: number[],
  segmentTypeIndex: number
): Promise<{
  segmentDimension: SegmentDimension
  records: DataRecord[]
}> {
  const allPaths: Array<{ path: string[]; data?: YearData }> = []
  
  // Extract paths directly from valueData to capture ALL data nodes including aggregations
  // This ensures we get aggregations that might not be in structure data
  // Also extract from volumeData if available to get complete path coverage
  if (valueData) {
    for (let i = 0; i < geographies.length; i++) {
      const geography = geographies[i]
      
      if (valueData[geography]?.[segmentType]) {
        // Use extractPathsGenerator directly on valueData to get all paths with year data
        // This will capture both leaf nodes and aggregation nodes
        const valueDataGenerator = extractPathsGenerator(
          valueData[geography][segmentType],
          [geography, segmentType]
        )
        
        // Collect all paths with data from valueData
        let count = 0
        for (const pathObj of valueDataGenerator) {
          if (pathObj.data) {
            // Check if path already exists (might be added from volumeData)
            const existingIndex = allPaths.findIndex(p => 
              p.path.length === pathObj.path.length &&
              p.path.every((val, idx) => val === pathObj.path[idx])
            )
            if (existingIndex === -1) {
              allPaths.push(pathObj)
            } else {
              // Merge data if path exists (in case volumeData added it first)
              // Prefer valueData metadata (_aggregated, _level) if present
              if (pathObj.data._aggregated !== undefined || pathObj.data._level !== undefined) {
                allPaths[existingIndex] = pathObj
              }
            }
            count++
            if (count % 1000 === 0) {
              await new Promise(resolve => setImmediate(resolve))
            }
          }
        }
      }
      
      // Also extract from volumeData if available to ensure complete path coverage
      // This helps with child detection when both files are uploaded
      if (volumeData && volumeData[geography]?.[segmentType]) {
        const volumeDataGenerator = extractPathsGenerator(
          volumeData[geography][segmentType],
          [geography, segmentType]
        )
        
        let count = 0
        for (const pathObj of volumeDataGenerator) {
          if (pathObj.data) {
            // Check if path already exists (from valueData)
            const existingIndex = allPaths.findIndex(p => 
              p.path.length === pathObj.path.length &&
              p.path.every((val, idx) => val === pathObj.path[idx])
            )
            if (existingIndex === -1) {
              // Only add if not already present (valueData takes precedence)
              allPaths.push(pathObj)
            }
            count++
            if (count % 1000 === 0) {
              await new Promise(resolve => setImmediate(resolve))
            }
          }
        }
      }
      
      // Yield control every 5 geographies
      if ((i + 1) % 5 === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  } else {
    // Fallback: Extract paths from structure data if valueData is not available
    // Then look up actual data from valueData/volumeData
    for (let i = 0; i < geographies.length; i++) {
      const geography = geographies[i]
      
      // Get structure from segmentation data
      if (structureData[geography]?.[segmentType]) {
        // Extract paths from structure using structure generator (handles empty objects)
        const structureGenerator = extractStructurePathsGenerator(
          structureData[geography][segmentType],
          [geography, segmentType]
        )
        // Collect structure paths (handles empty objects at leaf nodes)
        const structurePaths: Array<{ path: string[] }> = []
        let count = 0
        for (const pathObj of structureGenerator) {
          structurePaths.push(pathObj)
          count++
          if (count % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve))
          }
        }
        
        // For each path from structure, try to find matching data in valueData
        for (const structurePath of structurePaths) {
          // Try to find matching data in valueData using the same path
          let data: YearData | undefined = undefined
          
          if (valueData && valueData[geography]?.[segmentType]) {
            // Navigate to the same path in valueData
            // The path structure is: [geography, segmentType, ...segmentPath]
            // We need to navigate: valueData[geography][segmentType][...segmentPath]
            let currentValueData: any = valueData[geography][segmentType]
            const segmentPath = structurePath.path.slice(segmentTypeIndex + 1) // Remove geography and segmentType
            
            // Navigate through the segment path
            for (const segmentKey of segmentPath) {
              if (currentValueData && typeof currentValueData === 'object' && currentValueData[segmentKey] !== undefined) {
                currentValueData = currentValueData[segmentKey]
              } else {
                currentValueData = null
                break
              }
            }
            
            // If we found the data, extract year values and aggregation metadata
            if (currentValueData && typeof currentValueData === 'object') {
              const keys = Object.keys(currentValueData)
              const hasYearData = keys.some(key => /^\d{4}$/.test(key) || key === 'CAGR')
              if (hasYearData) {
                data = {}
                keys.forEach(key => {
                  if (/^\d{4}$/.test(key) || key === 'CAGR' || key === '_aggregated' || key === '_level') {
                    data![key] = currentValueData[key]
                  }
                })
              }
            }
          }
          
          // Only add paths that have data (skip structure-only paths without numeric data)
          if (data) {
            allPaths.push({ path: structurePath.path, data })
          }
        }
      }
      
      // Yield control every 5 geographies
      if ((i + 1) % 5 === 0) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }
  
  // Build segment hierarchy and records
  // IMPORTANT: Extract segments from structure FIRST (even without data) to populate filter options
  // Also extract from valueData/volumeData if structure doesn't have segments
  const segmentItems: string[] = []
  const hierarchy: Record<string, string[]> = {}
  const b2bHierarchy: Record<string, string[]> = {}
  const b2cHierarchy: Record<string, string[]> = {}
  const b2bItems: string[] = []
  const b2cItems: string[] = []
  const records: DataRecord[] = []
  
  // Helper function to extract segments from a data source
  const extractSegmentsFromSource = async (sourceData: RawJsonData, sourceName: string) => {
    // Special handling for "By Region" segment type - use geography names as parent hierarchy
    const isRegionSegmentType = segmentType === 'By Region' || segmentType === 'By State' || segmentType === 'By Country'

    for (let geoIdx = 0; geoIdx < geographies.length; geoIdx++) {
      const geography = geographies[geoIdx]
      if (sourceData[geography]?.[segmentType]) {
        // Use structure generator that handles empty objects and nodes with year data
        const structureGenerator = extractStructurePathsGenerator(
          sourceData[geography][segmentType],
          [geography, segmentType]
        )
        // Collect structure paths (no data, just paths)
        const structurePaths: Array<{ path: string[] }> = []
        let count = 0
        for (const pathObj of structureGenerator) {
          structurePaths.push(pathObj)
          count++
          if (count % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve))
          }
        }

        // For "By Region" segment type, build hierarchy using geography as parent
        if (isRegionSegmentType && geography !== 'Global') {
          // Add geography as a parent segment item
          if (!segmentItems.includes(geography)) {
            segmentItems.push(geography)
          }

          // IMPORTANT: Only build hierarchy if it hasn't been built yet
          // This prevents multiple sources from overwriting/contaminating the hierarchy
          if (!hierarchy[geography]) {
            hierarchy[geography] = []
          } else if (hierarchy[geography].length > 0) {
            // Hierarchy already built for this geography, skip
            console.log(`⏭️ Skipping ${geography} - hierarchy already built:`, hierarchy[geography])
            continue
          }

          // Extract countries/regions under this geography
          // For "By Region", the structure is: Geography -> By Region -> Geography (redundant) -> Countries
          // We need to get the DIRECT children from the data, not from paths

          // Get direct children from the actual data structure
          const regionData = sourceData[geography]?.[segmentType]
          console.log(`\n========================================`)
          console.log(`🌍 Processing: ${geography} from ${sourceName}`)
          console.log(`📍 Path: sourceData['${geography}']['${segmentType}']`)
          console.log(`✨ Hierarchy before processing:`, JSON.stringify(hierarchy[geography] || []))

          if (regionData && typeof regionData === 'object') {
            const allKeys = Object.keys(regionData)
            console.log(`🔑 All keys in regionData:`, allKeys)

            const directChildren = allKeys.filter(key => {
              // Skip year keys and metadata
              return !/^\d{4}$/.test(key) && key !== 'CAGR' && key !== '_aggregated' && key !== '_level'
            })

            console.log(`👶 Filtered directChildren:`, directChildren)

            // For "By Region", there's often a redundant geography level
            // e.g., data['North America']['By Region']['North America'] = { 'U.S.': {...}, 'Canada': {...} }
            // So if the only child is the geography name itself, go one level deeper
            if (directChildren.length === 1 && directChildren[0] === geography) {
              console.log(`  ⚠️ Found redundant geography level, going deeper...`)
              const nestedData = regionData[geography]
              if (nestedData && typeof nestedData === 'object') {
                const allNestedKeys = Object.keys(nestedData)
                console.log(`  🔑 All nested keys:`, allNestedKeys)

                const nestedChildren = allNestedKeys.filter(key => {
                  return !/^\d{4}$/.test(key) && key !== 'CAGR' && key !== '_aggregated' && key !== '_level'
                })
                console.log(`  👶 Filtered nested children:`, nestedChildren)

                nestedChildren.forEach(child => {
                  console.log(`    ➕ Adding '${child}' to hierarchy['${geography}']`)
                  if (!hierarchy[geography].includes(child)) {
                    hierarchy[geography].push(child)
                  } else {
                    console.log(`    ⏭️ Skipped '${child}' - already exists`)
                  }

                  // Also check if this child has its own children (sub-regions like GCC)
                  const childData = nestedData[child]
                  if (childData && typeof childData === 'object') {
                    const grandchildKeys = Object.keys(childData).filter(key => {
                      return !/^\d{4}$/.test(key) && key !== 'CAGR' && key !== '_aggregated' && key !== '_level'
                    })
                    // If grandchildKeys has items that are objects (not year data), build sub-hierarchy
                    const validGrandchildren = grandchildKeys.filter(key => {
                      const val = childData[key]
                      return val && typeof val === 'object' && !Array.isArray(val)
                    })
                    if (validGrandchildren.length > 0) {
                      console.log(`      📂 Found sub-hierarchy for '${child}':`, validGrandchildren)
                      if (!hierarchy[child]) {
                        hierarchy[child] = []
                      }
                      validGrandchildren.forEach(grandchild => {
                        if (!hierarchy[child].includes(grandchild)) {
                          hierarchy[child].push(grandchild)
                        }
                      })
                      // Add child to segmentItems if not already there
                      if (!segmentItems.includes(child)) {
                        segmentItems.push(child)
                      }
                    }
                  }
                })
              }
            } else {
              // No redundant level, use direct children
              console.log(`  ✅ No redundant level, using direct children`)
              directChildren.forEach(child => {
                // Don't add the geography itself as its own child
                if (child !== geography) {
                  console.log(`    ➕ Adding '${child}' to hierarchy['${geography}']`)
                  if (!hierarchy[geography].includes(child)) {
                    hierarchy[geography].push(child)
                  } else {
                    console.log(`    ⏭️ Skipped '${child}' - already exists`)
                  }

                  // Also check if this child has its own children (sub-regions like GCC)
                  const childData = regionData[child]
                  if (childData && typeof childData === 'object') {
                    const grandchildKeys = Object.keys(childData).filter(key => {
                      return !/^\d{4}$/.test(key) && key !== 'CAGR' && key !== '_aggregated' && key !== '_level'
                    })
                    // If grandchildKeys has items that are objects (not year data), build sub-hierarchy
                    const validGrandchildren = grandchildKeys.filter(key => {
                      const val = childData[key]
                      return val && typeof val === 'object' && !Array.isArray(val)
                    })
                    if (validGrandchildren.length > 0) {
                      console.log(`      📂 Found sub-hierarchy for '${child}':`, validGrandchildren)
                      if (!hierarchy[child]) {
                        hierarchy[child] = []
                      }
                      validGrandchildren.forEach(grandchild => {
                        if (!hierarchy[child].includes(grandchild)) {
                          hierarchy[child].push(grandchild)
                        }
                      })
                      // Add child to segmentItems if not already there
                      if (!segmentItems.includes(child)) {
                        segmentItems.push(child)
                      }
                    }
                  }
                } else {
                  console.log(`    ⛔ Skipped '${child}' - same as geography`)
                }
              })
            }

            console.log(`✅ Final hierarchy['${geography}']:`, hierarchy[geography])
          } else {
            console.log(`❌ No regionData found for ${geography}`)
          }
          console.log(`========================================\n`)
        } else {
          // Standard hierarchy building for non-region segment types
          // Build segment items and hierarchy from structure (not just paths with data)
          structurePaths.forEach(({ path: pathArray }) => {
            const segmentPath = pathArray.slice(segmentTypeIndex + 1)

            // Build hierarchy from structure
            // First, ensure all first-level items are in the hierarchy
            if (segmentPath.length > 0 && segmentPath[0] && segmentPath[0].trim() !== '') {
              const firstLevel = segmentPath[0]
              if (!segmentItems.includes(firstLevel)) {
                segmentItems.push(firstLevel)
              }
              if (!hierarchy[firstLevel]) {
                hierarchy[firstLevel] = []
              }

              // For self-referencing items (e.g., Oral -> Oral), add self as child
              if (segmentPath.length === 2 && segmentPath[0] === segmentPath[1]) {
                if (!hierarchy[firstLevel].includes(firstLevel)) {
                  hierarchy[firstLevel].push(firstLevel)
                }
              }
            }

            // Build the rest of the hierarchy
            segmentPath.forEach((seg, index) => {
              if (seg && seg.trim() !== '') { // Only add non-empty segments
                if (index === 0) {
                  // Already handled above
                } else {
                  const parent = segmentPath[index - 1]
                  if (parent && parent.trim() !== '') {
                    if (!hierarchy[parent]) hierarchy[parent] = []
                    if (!hierarchy[parent].includes(seg)) {
                      hierarchy[parent].push(seg)
                    }
                  }
                }
              }
            })

            // Check for B2B/B2C
            const level1 = segmentPath[0] || ''
            if (level1 === 'B2B' || level1 === 'B2C') {
              const segment = segmentPath[segmentPath.length - 1] || ''
              if (segment && segment.trim() !== '') {
                if (level1 === 'B2B') {
                  const parentKey = segmentPath[1] || ''
                  if (parentKey && !b2bHierarchy[parentKey]) {
                    b2bHierarchy[parentKey] = []
                  }
                  if (!b2bItems.includes(segment)) {
                    b2bItems.push(segment)
                  }
                } else {
                  const parentKey = segmentPath[1] || ''
                  if (parentKey && !b2cHierarchy[parentKey]) {
                    b2cHierarchy[parentKey] = []
                  }
                  if (!b2cItems.includes(segment)) {
                    b2cItems.push(segment)
                  }
                }
              }
            }
          })
        }

        console.log(`Extracted ${structurePaths.length} structure paths from ${sourceName} for ${geography} > ${segmentType}`)
        if (structurePaths.length > 0) {
          console.log(`Sample structure paths:`, structurePaths.slice(0, 3).map(p => p.path.join(' > ')))
        }
      }
    }
  }
  
  // First pass: Extract ALL segments from structure (segmentation JSON) to build complete segment list
  // This ensures segments are available in filters even if they don't have matching data in value/volume files
  if (structureData) {
    await extractSegmentsFromSource(structureData, 'structureData')
  }

  // ALWAYS also extract from valueData to catch segments that might only exist there
  // (e.g., self-referencing items like Oral -> Oral that might not be in structureData)
  if (valueData) {
    console.log('Also extracting from valueData to ensure complete hierarchy...')
    await extractSegmentsFromSource(valueData, 'valueData')
  }

  // Also extract from volumeData if available
  if (volumeData) {
    console.log('Also extracting from volumeData to ensure complete hierarchy...')
    await extractSegmentsFromSource(volumeData, 'volumeData')
  }
  
  // Also extract segments from allPaths if we have them (from valueData/volumeData extraction)
  if (segmentItems.length === 0 && allPaths.length > 0) {
    console.log('Extracting segments from allPaths...')
    const segmentSet = new Set<string>()
    allPaths.forEach(({ path: pathArray }) => {
      const segmentPath = pathArray.slice(segmentTypeIndex + 1)
      segmentPath.forEach(seg => {
        if (seg && seg.trim() !== '') {
          segmentSet.add(seg)
        }
      })
    })
    segmentItems.push(...Array.from(segmentSet))
    console.log(`Extracted ${segmentItems.length} segments from allPaths`)
  }
  
  console.log(`Total segment items extracted: ${segmentItems.length}`)
  console.log(`Sample segment items:`, segmentItems.slice(0, 10))
  console.log(`Hierarchy keys count: ${Object.keys(hierarchy).length}`, Object.keys(hierarchy).slice(0, 10))
  
  // Create path index for fast child lookups (performance optimization)
  // This converts O(n*m) complexity to O(n) for child detection
  console.log('Creating path index for fast child lookups...')
  const pathIndex = createPathIndex(allPaths.map(p => ({ path: p.path })))
  console.log(`Path index created with ${pathIndex.size} parent entries`)
  
  // Second pass: Process paths with data to create records
  const batchSize = 1000
  for (let i = 0; i < allPaths.length; i += batchSize) {
    const batch = allPaths.slice(i, i + batchSize)
    
    for (const { path: pathArray, data } of batch) {
      if (!data) continue // Skip paths without numeric data

      let geography = pathArray[0]
      const segmentPath = pathArray.slice(segmentTypeIndex + 1)

      // SPECIAL HANDLING for "By Region" segment type:
      // Use the most specific geography level from the segment path
      // Path structure: [Global, By Region, North America, U.S.]
      // segmentPath: [North America, U.S.]
      // For country-level: geography = "U.S." (deepest level)
      // For region-level (self-referencing like North America > North America): geography = "North America"
      const isRegionSegmentType = segmentType === 'By Region' || segmentType === 'By State' || segmentType === 'By Country'
      if (isRegionSegmentType && segmentPath.length > 0 && segmentPath[0]) {
        const regionName = segmentPath[0]
        const entityName = segmentPath.length > 1 ? segmentPath[segmentPath.length - 1] : regionName
        // If the entity name equals the region name, it's a region aggregate
        // Otherwise it's a country-level record
        if (entityName !== regionName) {
          geography = entityName // Use country name as geography (e.g., "U.S.")
        } else {
          geography = regionName // Use region name as geography (e.g., "North America")
        }
      }
      
      // Extract aggregation metadata from JSON first
      // Handle both boolean and string representations of _aggregated
      const hasAggregatedFlag = data._aggregated === true || data._aggregated === 'true'
      let isAggregated = hasAggregatedFlag
      // Handle _level as number or string, and ensure 0 is treated as valid
      let aggregationLevel: number | null = null
      if (data._level !== undefined && data._level !== null && data._level !== '') {
        const levelNum = typeof data._level === 'string' ? parseInt(data._level, 10) : Number(data._level)
        if (!isNaN(levelNum)) {
          aggregationLevel = levelNum
        }
      }
      
      // If _aggregated flag is explicitly set, prioritize it
      // This ensures that pre-calculated aggregations are always recognized
      
      // If _level is missing but _aggregated is true, we need to infer the level
      // Also infer if _level is missing (common when uploading via dashboard builder)
      if (aggregationLevel === null || (isAggregated && aggregationLevel === null)) {
        // Check if this path has children in the structure, value data, or other paths to determine if it's aggregated
        // Pass allPaths and pathIndex for optimized lookup
        const hasChildren = checkIfPathHasChildren(structureData, pathArray, valueData, volumeData, allPaths, pathIndex)
        
        // Debug logging for child detection
        if (process.env.NODE_ENV === 'development' && !hasChildren && hasAggregatedFlag) {
          console.log(`🔍 Child detection for aggregated path [${pathArray.join(' > ')}]:`, {
            hasChildren,
            allPathsCount: allPaths?.length || 0,
            pathArrayLength: pathArray.length,
            hasStructureData: !!structureData,
            hasValueData: !!valueData
          })
        }
        
        // Calculate level based on segment path depth
        // Level 1 = no segments (segmentPath.length = 0) - total aggregation
        // Level 2 = 1 segment (segmentPath.length = 1) - first segment level
        // Level 3 = 2 segments (segmentPath.length = 2) - second segment level
        // etc.
        const calculatedLevel = segmentPath.length + 1
        
        // IMPORTANT: When both value and volume are uploaded, allPaths should contain all paths
        // But if allPaths check fails, also check volumeData if available
        let hasChildrenFinal = hasChildren
        
        // If _aggregated flag is explicitly true, trust it even if hasChildren check fails
        // This handles cases where aggregations were calculated but structure check is incomplete
        if (isAggregated && !hasChildren && pathIndex) {
          // Double-check using path index (fast O(1) lookup)
          const parentKey = pathArray.join('|')
          const indexedChildren = pathIndex.get(parentKey)
          if (indexedChildren && indexedChildren.length > 0) {
            hasChildrenFinal = true
          } else if (isAggregated) {
            // If _aggregated is true but we can't find children, still trust the flag
            // This can happen when aggregations were pre-calculated
            hasChildrenFinal = true
          }
        } else if (!hasChildren && pathIndex) {
          // Double-check using path index (fast O(1) lookup)
          const parentKey = pathArray.join('|')
          const indexedChildren = pathIndex.get(parentKey)
          if (indexedChildren && indexedChildren.length > 0) {
            hasChildrenFinal = true
          }
        }
        
        if (hasChildrenFinal || hasAggregatedFlag) {
          // This path has children OR is marked as aggregated, so it's an aggregated record
          aggregationLevel = calculatedLevel
          isAggregated = true
        } else {
          // This is a leaf record (no children)
          // For leaf records, set aggregation_level to their depth so they can be filtered correctly
          // This allows leaf records to be included when filtering by their level
          aggregationLevel = calculatedLevel
          isAggregated = false
        }
        
        // Debug logging for uploaded data
        if (process.env.NODE_ENV === 'development') {
          console.log(`📊 Inferred aggregation level for path [${pathArray.join(' > ')}]:`, {
            segmentPath: segmentPath,
            segmentPathLength: segmentPath.length,
            calculatedLevel,
            hasChildren,
            hasChildrenFinal,
            isAggregated,
            aggregationLevel,
            allPathsCount: allPaths?.length || 0,
            dataHasAggregatedFlag: data._aggregated,
            dataHasLevelFlag: data._level
          })
        }
      } else if (hasAggregatedFlag && aggregationLevel === null) {
        // If _aggregated is true but _level is still null after inference, use calculated level
        // This ensures aggregated nodes always have a level set
        aggregationLevel = segmentPath.length + 1
        isAggregated = true
        console.warn(`⚠️ Aggregated node at path [${pathArray.join(' > ')}] had _aggregated=true but no _level. Using calculated level ${aggregationLevel}`)
      }
      
      // Final safeguard: if _aggregated flag is set, always respect it
      if (hasAggregatedFlag) {
        isAggregated = true
        if (aggregationLevel === null) {
          aggregationLevel = segmentPath.length + 1
        }
      }
      
      // Determine segment name based on aggregation level
      // JSON structure:
      // - Level 1: Path = [geography, segmentType] - no segments (total aggregation)
      // - Level 2: Path = [geography, segmentType, segment1] - first segment level
      // - Level 3: Path = [geography, segmentType, segment1, segment2] - second segment level
      // - etc.
      let segment: string
      if (isAggregated && aggregationLevel !== null && aggregationLevel > 0) {
        if (aggregationLevel === 1) {
          // Level 1: No segments in path, this is the total aggregation
          // Use special marker
          segment = '__ALL_SEGMENTS__'
        } else {
          // Level 2+: segmentPath[0] is Level 2, segmentPath[1] is Level 3, etc.
          // aggregationLevel 2 -> segmentPath[0]
          // aggregationLevel 3 -> segmentPath[1]
          // aggregationLevel N -> segmentPath[N-2]
          const levelIndex = aggregationLevel - 2
          if (levelIndex >= 0 && levelIndex < segmentPath.length && segmentPath[levelIndex]) {
            segment = segmentPath[levelIndex]
          } else if (segmentPath.length > 0) {
            // Fallback: use last segment in path if available
            segment = segmentPath[segmentPath.length - 1] || ''
          } else {
            // If segmentPath is empty, this shouldn't happen but handle it gracefully
            console.warn(`Empty segmentPath for aggregated record at level ${aggregationLevel}, path:`, pathArray)
            segment = ''
          }
        }
      } else {
        // For leaf records (not aggregated), use the last segment in the path
        segment = segmentPath[segmentPath.length - 1] || ''
      }
      
      // Build time series
      const timeSeries: Record<number, number> = {}
      allYears.forEach(year => {
        const yearStr = year.toString()
        timeSeries[year] = data[yearStr] !== null && data[yearStr] !== undefined ? (data[yearStr] as number) : 0
      })
      
      // Parse CAGR - it might be a string like "5.2%" or a number
      // If not provided in data, calculate from time series
      let cagr = 0
      if (data.CAGR !== null && data.CAGR !== undefined) {
        if (typeof data.CAGR === 'string') {
          // Extract number from string like "5.2%" or "5.2"
          const cagrStr = data.CAGR.replace('%', '').trim()
          cagr = parseFloat(cagrStr) || 0
        } else if (typeof data.CAGR === 'number') {
          cagr = data.CAGR
        }
      } else {
        // Calculate CAGR from base year (2023) to forecast year
        const cagrStartYear = allYears[0] + 4 // Base year = 2023 for 2019-2031 data
        const cagrEndYear = allYears[allYears.length - 1]
        const startVal = timeSeries[cagrStartYear] || 0
        const endVal = timeSeries[cagrEndYear] || 0
        const numYears = cagrEndYear - cagrStartYear
        if (startVal > 0 && endVal > 0 && numYears > 0) {
          cagr = (Math.pow(endVal / startVal, 1 / numYears) - 1) * 100
        }
      }
      
      records.push({
        geography,
        geography_level: 'country',
        parent_geography: null,
        segment_type: segmentType,
        segment,
        segment_level: getSegmentLevel(pathArray, allPaths, segmentTypeIndex),
        segment_hierarchy: buildSegmentHierarchy(pathArray, 0, segmentTypeIndex),
        time_series: timeSeries,
        cagr,
        market_share: 0,
        is_aggregated: isAggregated,
        aggregation_level: aggregationLevel
      })
    }
    
    // Yield control between batches
    await new Promise(resolve => setImmediate(resolve))
  }
  
  return {
    segmentDimension: {
      type: 'hierarchical',
      items: segmentItems,
      hierarchy,
      b2b_hierarchy: Object.keys(b2bHierarchy).length > 0 ? b2bHierarchy : undefined,
      b2c_hierarchy: Object.keys(b2cHierarchy).length > 0 ? b2cHierarchy : undefined,
      b2b_items: b2bItems.length > 0 ? b2bItems : undefined,
      b2c_items: b2cItems.length > 0 ? b2cItems : undefined,
    },
    records
  }
}

/**
 * Process raw JSON data into ComparisonData format (Async version)
 */
export async function processJsonDataAsync(
  valueData: RawJsonData,
  volumeData: RawJsonData | null,
  segmentationData: RawJsonData | null
): Promise<ComparisonData> {
  try {
    console.log('Starting async processJsonData...')
    
    // Use segmentationData for structure (geographies and segments)
    // Use valueData/volumeData for numeric data (years, values, CAGR)
    const structureData = segmentationData || valueData
    
    if (!structureData) {
      throw new Error('No structure data available (need segmentation or value data)')
    }
    
    // Extract all years asynchronously from value data (or volume if value not available)
    console.log('Extracting years...')
    const dataForYears = valueData || volumeData
    let allYears: number[] = []
    if (dataForYears) {
      allYears = await extractYearsAsync(dataForYears)
    }
    if (allYears.length === 0) {
      // Fallback: try to extract from structure data
      console.warn('No years found in value/volume data, trying structure data...')
      allYears = await extractYearsAsync(structureData)
    }
    if (allYears.length === 0) {
      throw new Error('No years found in any data source')
    }
    const startYear = Math.min(...allYears)
    const forecastYear = Math.max(...allYears)
    const baseYear = startYear + 5 // Base year = 2026 for 2021-2033 data
    // Historical/Forecast split: years before base year are historical
    const historicalEndYear = baseYear - 1 // 2025
    console.log(`Years: ${startYear} to ${forecastYear}, base: ${baseYear}, historical end: ${historicalEndYear}`)
    
    // Extract geographies from segmentation data (first level keys)
    // This is truly dynamic - works with any structure (global, country, region, etc.)
    console.log('Extracting geographies from segmentation data...')
    let geographies: string[] = []

    if (structureData && typeof structureData === 'object') {
      geographies = Object.keys(structureData).filter(key => {
        // Filter out any non-string keys or invalid entries
        const value = structureData[key]
        return value && typeof value === 'object' && !Array.isArray(value)
      })
    }

    if (geographies.length === 0) {
      // Fallback: try to extract from value data if segmentation doesn't have geographies
      console.warn('No geographies found in segmentation data, trying value data...')
      if (valueData && typeof valueData === 'object') {
        geographies = Object.keys(valueData).filter(key => {
          const value = valueData[key]
          return value && typeof value === 'object' && !Array.isArray(value)
        })
      }
    }

    if (geographies.length === 0) {
      throw new Error('No geographies found in any data source. Please check your JSON structure.')
    }

    // Build geography hierarchy from "By Country" and "By Region" segment types
    // Supports: North America > U.S./Canada > U.S. sub-regions (Northeast, etc.)
    const regionGeographies: string[] = []
    const regionToCountries: Record<string, string[]> = {}
    const allCountries: string[] = []

    const isGeoSegmentKey = (key: string) =>
      !/^\d{4}$/.test(key) && key !== 'CAGR' && key !== '_aggregated' && key !== '_level'

    const getDirectChildren = (node: Record<string, unknown> | undefined): string[] => {
      if (!node || typeof node !== 'object') return []
      return Object.keys(node).filter(key => {
        if (!isGeoSegmentKey(key)) return false
        const value = node[key]
        return value && typeof value === 'object' && !Array.isArray(value)
      })
    }

    for (const topGeo of geographies) {
      const geoData = structureData[topGeo]
      if (!geoData || typeof geoData !== 'object') continue

      // Countries under a top-level geography (e.g. North America > By Country > U.S., Canada)
      const byCountryData = geoData['By Country'] as Record<string, unknown> | undefined
      if (byCountryData) {
        const countries = getDirectChildren(byCountryData)
        if (countries.length > 0) {
          regionToCountries[topGeo] = countries
          countries.forEach(country => {
            if (!regionGeographies.includes(country)) {
              regionGeographies.push(country)
            }
          })
        }
      }

      // Sub-regions under a country (e.g. U.S. > By Region > Northeast, Southeast, ...)
      const byRegionData = geoData['By Region'] as Record<string, unknown> | undefined
      if (byRegionData) {
        const subRegions = getDirectChildren(byRegionData)
        if (subRegions.length > 0) {
          // If this geo is already a country/region in the hierarchy, nest sub-regions under it
          if (regionGeographies.includes(topGeo) || geographies.includes(topGeo)) {
            regionToCountries[topGeo] = subRegions
            subRegions.forEach(subRegion => {
              if (!allCountries.includes(subRegion)) {
                allCountries.push(subRegion)
              }
            })
          } else {
            // Legacy: top-level "By Region" (multi-region global datasets)
            subRegions.forEach(region => {
              if (!regionGeographies.includes(region) && !geographies.includes(region)) {
                regionGeographies.push(region)
              }
              const regionData = byRegionData[region] as Record<string, unknown> | undefined
              const nestedCountries = getDirectChildren(regionData).filter(key => key !== region)
              if (nestedCountries.length > 0) {
                regionToCountries[region] = nestedCountries
                nestedCountries.forEach(country => {
                  if (!allCountries.includes(country)) {
                    allCountries.push(country)
                  }
                })
              }
            })
          }
        }
      }
    }

    // Add sub-regions to geographies list (countries in the UI hierarchy sense)
    if (allCountries.length > 0) {
      console.log(`Found ${allCountries.length} sub-regions/countries:`, allCountries)
      geographies = [...geographies, ...allCountries]
    }

    console.log(`Found ${geographies.length} total geographies:`, geographies)
    const geographySet = new Set(geographies)

    // Extract segment types from segmentation data (second level keys)
    console.log('Extracting segment types from segmentation data...')
    const segmentTypes = new Set<string>()
    Object.values(structureData).forEach(geography => {
      if (geography && typeof geography === 'object') {
        Object.keys(geography).forEach(segType => {
          segmentTypes.add(segType)
        })
      }
    })
    if (segmentTypes.size === 0) {
      throw new Error('No segment types found in segmentation data')
    }
    console.log(`Found ${segmentTypes.size} segment types:`, Array.from(segmentTypes))

    // Remove "By Region" (and similar) from segment types - these are geography dimensions, not segments
    segmentTypes.delete('By Region')
    segmentTypes.delete('By State')
    segmentTypes.delete('By Country')
    console.log(`Segment types after removing geography types:`, Array.from(segmentTypes))

    // Filter out geographies that only exist in segmentation structure but have no actual data
    // in value/volume files (e.g., "Global" when only region/country-level data exists)
    const geographiesWithData = new Set<string>()
    if (valueData) {
      Object.keys(valueData).forEach(g => geographiesWithData.add(g))
    }
    if (volumeData) {
      Object.keys(volumeData).forEach(g => geographiesWithData.add(g))
    }

    // Remove geographies from the list if they have no value/volume data
    // But keep them if they are regions or countries (which get data from "By Region" processing)
    const filteredGeographies = geographies.filter(g => {
      // Always keep regions and countries (they have data under parent geographies)
      if (regionGeographies.includes(g) || allCountries.includes(g)) return true
      // For top-level geographies (like "Global"), only keep if they have actual data
      return geographiesWithData.has(g)
    })

    // Build geography dimension with full hierarchy
    const geographyDimension: GeographyDimension = {
      global: filteredGeographies.filter(g => !regionGeographies.includes(g) && !allCountries.includes(g)),
      regions: regionGeographies,
      countries: regionToCountries,
      all_geographies: filteredGeographies
    }

    console.log(`Geography dimension built with ${geographies.length} geographies:`, geographies)
    console.log(`Regions:`, regionGeographies)
    console.log(`Countries by region:`, regionToCountries)
    
    // Process each segment type asynchronously
    const segments: Record<string, SegmentDimension> = {}
    const valueRecords: DataRecord[] = []
    const volumeRecords: DataRecord[] = []
    const segmentTypeIndex = 1
    
    for (const segmentType of segmentTypes) {
      console.log(`Processing segment type: ${segmentType}`)
      const { segmentDimension, records } = await processSegmentTypeAsync(
        structureData, // Use segmentation data for structure
        valueData,     // Use value data for numeric values
        volumeData,    // Use volume data for volume values
        segmentType,
        geographies,
        allYears,
        segmentTypeIndex
      )
      segments[segmentType] = segmentDimension
      valueRecords.push(...records)

      // Yield control between segment types
      await new Promise(resolve => setImmediate(resolve))
    }

    // Process "By Region" data separately for geography-based records
    // These records are NOT added to segment types but provide data for region/country geographies
    const geoSegmentTypes = ['By Region', 'By State', 'By Country']
    for (const geoSegType of geoSegmentTypes) {
      // Check if this geo segment type exists in the structure data
      const hasGeoSegType = Object.values(structureData).some(
        (geo: any) => geo && typeof geo === 'object' && geo[geoSegType]
      )
      if (hasGeoSegType) {
        console.log(`Processing geography segment type: ${geoSegType} (for geography records only)`)
        const { records: geoRecords } = await processSegmentTypeAsync(
          structureData,
          valueData,
          volumeData,
          geoSegType,
          geographies,
          allYears,
          segmentTypeIndex
        )
        valueRecords.push(...geoRecords)
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    
    // Process volume data separately if available
    if (volumeData) {
      console.log('Processing volume data...')
      for (const segmentType of segmentTypes) {
        const { records: volumeRecs } = await processSegmentTypeAsync(
          structureData,
          volumeData,  // Use volume data for numeric values
          null,
          segmentType,
          geographies,
          allYears,
          segmentTypeIndex
        )
        volumeRecords.push(...volumeRecs)
      }
      // Also process "By Region" geography records for volume
      for (const geoSegType of geoSegmentTypes) {
        const hasGeoSegType = Object.values(structureData).some(
          (geo: any) => geo && typeof geo === 'object' && geo[geoSegType]
        )
        if (hasGeoSegType) {
          console.log(`Processing volume geography segment type: ${geoSegType}`)
          const { records: volumeGeoRecs } = await processSegmentTypeAsync(
            structureData,
            volumeData,
            null,
            geoSegType,
            geographies,
            allYears,
            segmentTypeIndex
          )
          volumeRecords.push(...volumeGeoRecs)
        }
      }
    }
    
    // Calculate market share for each record
    const calculateMarketShare = (records: DataRecord[], year: number) => {
      const yearTotal = records.reduce((sum, r) => sum + (r.time_series[year] || 0), 0)
      records.forEach(record => {
        const value = record.time_series[year] || 0
        record.market_share = yearTotal > 0 ? (value / yearTotal) * 100 : 0
      })
    }
    
    // Calculate market share for base year
    calculateMarketShare(valueRecords, baseYear)
    if (volumeRecords.length > 0) {
      calculateMarketShare(volumeRecords, baseYear)
    }
    
    // Build metadata
    const metadata: Metadata = {
      market_name: '& US Trocar Market',
      market_type: 'Market Analysis',
      industry: 'Medical Devices',
      years: allYears,
      start_year: startYear,
      base_year: baseYear,
      forecast_year: forecastYear,
      historical_years: allYears.filter(y => y <= historicalEndYear),
      forecast_years: allYears.filter(y => y > historicalEndYear),
      currency: 'USD',
      value_unit: 'Million',
      volume_unit: 'Thousand Units',
      has_value: valueRecords.length > 0,
      has_volume: volumeRecords.length > 0,
    }
    
    console.log(`Async processing complete. Records: ${valueRecords.length} value, ${volumeRecords.length} volume`)
    
    return {
      metadata,
      dimensions: {
        geographies: geographyDimension,
        segments,
      },
      data: {
        value: {
          geography_segment_matrix: valueRecords,
        },
        volume: {
          geography_segment_matrix: volumeRecords,
        },
      },
    }
  } catch (error) {
    console.error('Error in processJsonDataAsync:', error)
    throw new Error(
      `Failed to process JSON data: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Synchronous version (kept for backward compatibility)
 * Note: This is a wrapper that calls the async version
 * For better performance, use processJsonDataAsync directly
 */
export function processJsonData(
  valueData: RawJsonData,
  volumeData: RawJsonData | null,
  segmentationData: RawJsonData | null
): ComparisonData {
  // This should not be called in the new async flow
  // But kept for any legacy code that might still use it
  throw new Error('Synchronous processJsonData is deprecated. Use processJsonDataAsync instead.')
}

/**
 * Load and process JSON files
 */
export async function loadAndProcessJsonFiles(
  valueJsonPath: string,
  volumeJsonPath: string | null = null,
  segmentationJsonPath: string | null = null
): Promise<ComparisonData> {
  try {
    console.log('Loading JSON files asynchronously...')
    
    // Read files in parallel using async fs
    const readPromises = [
      fs.readFile(valueJsonPath, 'utf-8'),
      volumeJsonPath ? fs.readFile(volumeJsonPath, 'utf-8').catch(() => null) : Promise.resolve(null),
      segmentationJsonPath ? fs.readFile(segmentationJsonPath, 'utf-8').catch(() => null) : Promise.resolve(null)
    ]
    
    const [valueContent, volumeContent, segmentationContent] = await Promise.all(readPromises)
    
    if (!valueContent) {
      throw new Error('Value JSON file is required but was not found')
    }
    
    console.log(`Value JSON size: ${(valueContent.length / 1024 / 1024).toFixed(2)} MB`)
    
    // Parse JSON asynchronously (using setImmediate to yield)
    let valueData: RawJsonData
    await new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          valueData = JSON.parse(valueContent)
          console.log('Value JSON parsed successfully')
          resolve()
        } catch (error) {
          throw new Error(`Failed to parse value JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    })
    
    let volumeData: RawJsonData | null = null
    if (volumeContent) {
      await new Promise<void>(resolve => {
        setImmediate(() => {
          try {
            volumeData = JSON.parse(volumeContent)
            console.log('Volume JSON parsed successfully')
          } catch (error) {
            console.warn(`Failed to parse volume JSON: ${error instanceof Error ? error.message : String(error)}`)
          }
          resolve()
        })
      })
    }
    
    let segmentationData: RawJsonData = valueData!
    if (segmentationContent) {
      await new Promise<void>(resolve => {
        setImmediate(() => {
          try {
            segmentationData = JSON.parse(segmentationContent)
            console.log('Segmentation JSON parsed successfully')
          } catch (error) {
            console.warn(`Failed to parse segmentation JSON: ${error instanceof Error ? error.message : String(error)}. Using value data.`)
            segmentationData = valueData!
          }
          resolve()
        })
      })
    } else {
      console.log('Using value data structure for segmentation')
    }
    
    // Process asynchronously
    console.log('Processing JSON data asynchronously...')
    const result = await processJsonDataAsync(valueData!, volumeData, segmentationData)
    console.log('JSON data processed successfully')
    
    return result
  } catch (error) {
    console.error('Error in loadAndProcessJsonFiles:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined
    throw new Error(
      `Failed to load/process JSON files: ${errorMessage}${errorStack ? `\nStack: ${errorStack}` : ''}`
    )
  }
}

