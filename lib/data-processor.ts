import type { DataRecord, FilterState, ChartDataPoint, HeatmapCell, ComparisonTableRow } from './types'

/**
 * Calculate proportional distribution shares for geographies based on "By Region" data.
 * When Global-level data needs to be distributed across selected geographies,
 * this uses actual regional market data instead of even distribution.
 */
export function getGeographyProportions(
  byRegionRecords: DataRecord[],
  selectedGeographies: string[],
  year: number,
  geographyCountries?: Record<string, string[]>
): Map<string, number> {
  const selectedNonGlobal = selectedGeographies.filter(g => g !== 'Global')

  if (selectedNonGlobal.length === 0) {
    return new Map()
  }

  if (byRegionRecords.length === 0) {
    // No "By Region" data - fall back to even distribution
    const evenShare = 1.0 / selectedNonGlobal.length
    return new Map(selectedNonGlobal.map(geo => [geo, evenShare]))
  }

  // Build a map of geography -> value from "By Region" records for this year
  // Prefer aggregated records over leaf records to avoid double-counting
  const geoValues = new Map<string, number>()
  byRegionRecords.forEach(record => {
    const value = record.time_series[year] || 0
    if (value > 0) {
      if (record.is_aggregated) {
        geoValues.set(record.geography, value)
      } else if (!geoValues.has(record.geography)) {
        geoValues.set(record.geography, value)
      }
    }
  })

  // Calculate proportions for selected geographies
  const proportions = new Map<string, number>()
  let totalSelectedValue = 0

  selectedNonGlobal.forEach(geo => {
    let value = geoValues.get(geo) || 0

    // If this is a country and we don't have direct data,
    // derive from parent region proportionally
    if (value === 0 && geographyCountries) {
      for (const [region, countries] of Object.entries(geographyCountries)) {
        if (countries.includes(geo)) {
          const regionValue = geoValues.get(region) || 0
          if (regionValue > 0) {
            // Distribute region value among its countries
            // Check if any sibling countries have actual data for better proportioning
            const siblingValues = countries.map(c => geoValues.get(c) || 0)
            const siblingTotal = siblingValues.reduce((a, b) => a + b, 0)
            if (siblingTotal > 0) {
              // Use actual country data relative to siblings
              value = geoValues.get(geo) || (regionValue / countries.length)
            } else {
              value = regionValue / countries.length
            }
          }
          break
        }
      }
    }

    proportions.set(geo, value)
    totalSelectedValue += value
  })

  // Normalize proportions to sum to 1.0
  if (totalSelectedValue > 0) {
    proportions.forEach((value, geo) => {
      proportions.set(geo, value / totalSelectedValue)
    })
  } else {
    // Fallback to even distribution if no regional data found
    const evenShare = 1.0 / selectedNonGlobal.length
    selectedNonGlobal.forEach(geo => {
      proportions.set(geo, evenShare)
    })
  }

  return proportions
}

/**
 * Automatically determine the appropriate aggregation level based on selected segments
 * This hides the complexity from users - they just select segments, we figure out the level
 */
export function determineAggregationLevel(
  records: DataRecord[],
  selectedSegments: string[],
  segmentType: string
): number | null {
  if (selectedSegments.length === 0) {
    // No segments selected - show leaf level (most granular)
    return null // null means "show all levels, prefer leaf records"
  }

  // Analyze the hierarchy depth of selected segments
  const selectedRecords = records.filter(r => 
    r.segment_type === segmentType && 
    selectedSegments.includes(r.segment)
  )

  if (selectedRecords.length === 0) {
    return null
  }

  // Check if selected segments are all at the same level
  const levels = new Set(selectedRecords.map(r => r.aggregation_level))
  const aggregatedLevels = selectedRecords
    .filter(r => r.is_aggregated)
    .map(r => r.aggregation_level)

  // If all selected segments have aggregated records at the same level, use that
  if (aggregatedLevels.length > 0) {
    const mostCommonLevel = aggregatedLevels.reduce((a, b, _, arr) =>
      arr.filter(v => v === a).length >= arr.filter(v => v === b).length ? a : b
    )
    return mostCommonLevel ?? null
  }

  // Otherwise, determine level based on hierarchy depth
  // Find the deepest level that contains all selected segments
  const levelsArray = Array.from(levels).filter((l): l is number => l !== null && l !== undefined)
  const maxDepth = levelsArray.length > 0 ? Math.max(...levelsArray) : 0
  
  // If segments are at different levels, prefer showing leaf records (null)
  // This allows mixing levels in one view
  if (levels.size > 1) {
    return null // Show all levels together
  }

  return maxDepth
}

/**
 * Filter data records based on current filter state
 * Now with automatic aggregation level detection
 */
export function filterData(
  data: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] },
  geographyCountries?: Record<string, string[]>
): DataRecord[] {
  // Require at least one geography — empty selection should show no chart data
  if (!filters.geographies || filters.geographies.length === 0) {
    return []
  }

  // AUTOMATIC LEVEL DETECTION: Determine level based on selected segments
  // Hide aggregation level complexity from users
  let effectiveAggregationLevel = filters.aggregationLevel

  // Special handling for regional segment types: "By Region", "By State", "By Country"
  // These segment types have geographies as segments, so the hierarchy is different
  // Don't force aggregation level 2 for these - let all records through
  const isRegionalSegmentType = filters.segmentType === 'By Region' ||
                                 filters.segmentType === 'By State' ||
                                 filters.segmentType === 'By Country'

  // If aggregationLevel is explicitly set to null or undefined, use automatic detection
  if (effectiveAggregationLevel === null || effectiveAggregationLevel === undefined) {
    const selectedSegments = filters.segments || []
    const advancedSegments = filters.advancedSegments || []

    // Check if any selected segments are from the SAME segment type as the current filter
    // If segments are from a different type, they don't affect the aggregation level for this segment type
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    // Also check filters.segments (from SegmentMultiSelect single-type selection)
    const hasSegmentsForCurrentType = segmentsFromSameType.length > 0 || selectedSegments.length > 0

    if (hasSegmentsForCurrentType) {
      // User has explicitly selected segments - DON'T use automatic level detection
      // Set to null so we show the actual leaf records (sub-segments) not aggregated parent
      // For example: If user selects "Parenteral", show Intravenous, Intramuscular, Subcutaneous
      // NOT the aggregated "Parenteral" record
      effectiveAggregationLevel = null
      console.log('🔍 filterData: User selected segments, setting effectiveAggregationLevel to null to show sub-segments')
    } else if (isRegionalSegmentType) {
      // SPECIAL CASE: For regional segment types, DON'T default to level 2
      // Regional segment types have geography names as segments (e.g., "U.S." under "By Region")
      // These records typically have aggregation_level = 3 (not 2), so forcing level 2 would filter them out
      effectiveAggregationLevel = null
      console.log('🔍 filterData: Regional segment type', filters.segmentType, ', allowing all aggregation levels')
    } else {
      // NO SEGMENTS SELECTED FOR THIS SEGMENT TYPE: Default to showing Level 1 segments only (aggregation_level 2)
      // This ensures we don't show sub-segments when no specific segments are chosen for this type
      // For example: Show Oral, Parenteral, Topical, etc. but NOT Intravenous, Intramuscular, etc.
      effectiveAggregationLevel = 2
      console.log('🔍 filterData: No segments selected for segment type', filters.segmentType, ', defaulting to aggregation_level 2 (Level 1 segments)')
    }
  }
  
  console.log('🔍 filterData called with aggregationLevel:', filters.aggregationLevel, 'effectiveLevel:', effectiveAggregationLevel)
  console.log('🔍 Total records:', data.length)
  if (effectiveAggregationLevel !== null && effectiveAggregationLevel !== undefined) {
    const recordsAtLevel = data.filter(r => r.aggregation_level === effectiveAggregationLevel)
    const leafRecordsAtLevel = data.filter(r => r.is_aggregated === false && r.aggregation_level === effectiveAggregationLevel)
    console.log(`🔍 Records at level ${effectiveAggregationLevel}:`, {
      total: recordsAtLevel.length,
      aggregated: recordsAtLevel.filter(r => r.is_aggregated === true).length,
      leaf: leafRecordsAtLevel.length,
      sample: recordsAtLevel.slice(0, 3).map(r => ({
        geo: r.geography,
        segment: r.segment,
        level: r.aggregation_level,
        isAgg: r.is_aggregated,
        hierarchy: r.segment_hierarchy
      }))
    })
  }
  
  // Pre-compute which selected geographies have their own records for the current segment type
  // This is used to avoid double-counting by NOT including Global/child fallback records
  // when the selected geography already has its own data
  const selectedGeosWithOwnData = new Set<string>()
  if (filters.geographies.length > 0) {
    for (const geo of filters.geographies) {
      const hasOwnData = data.some(r =>
        r.geography === geo &&
        r.segment_type === filters.segmentType
      )
      if (hasOwnData) {
        selectedGeosWithOwnData.add(geo)
      }
    }
  }

  const filtered = data.filter((record) => {
    // 1. Geography filter - enhanced to handle parent-child relationships
    // In geography mode, when a parent geography is selected (e.g., "North America"),
    // also include records from child geographies (e.g., "U.S.", "Canada")

    // SPECIAL CASE: For regional segment types ("By Region", "By State", "By Country"),
    // skip the geography filter entirely because:
    // - "By Region" data exists under regional geographies (North America, Europe, etc.), NOT under Global
    // - The segments themselves ARE the geographical breakdown (e.g., U.S. under North America > By Region)
    // - Filtering by geography would incorrectly exclude all records when "Global" is selected
    let geoMatch = filters.geographies.includes(record.geography) ||
      isRegionalSegmentType // Skip geography filter for regional segment types

    // Also match if the record's parent geography is in the selected list
    // This allows selecting "North America" to include U.S., Canada records
    if (!geoMatch && record.parent_geography && filters.geographies.includes(record.parent_geography)) {
      geoMatch = true
    }

    // Fallback logic: include child-geography or Global records ONLY when
    // the selected geography does NOT have its own data for the current segment type.
    // This prevents double-counting (e.g., North America + U.S. + Canada + Global).
    if (!geoMatch) {
      // Use dynamic region-to-country mapping from data if available, with fallback
      const regionToCountriesMap: Record<string, string[]> = geographyCountries || {
        'North America': ['U.S.', 'Canada'],
        'Europe': ['U.K.', 'Germany', 'Italy', 'France', 'Spain', 'Russia', 'Rest of Europe'],
        'Asia Pacific': ['China', 'India', 'Japan', 'South Korea', 'ASEAN', 'Australia', 'Rest of Asia Pacific'],
        'Latin America': ['Brazil', 'Argentina', 'Mexico', 'Rest of Latin America'],
        'Middle East & Africa': ['GCC', 'South Africa', 'Rest of Middle East & Africa']
      }

      // If a region is selected and this record is a country in that region, include it
      // BUT only if the selected region does NOT already have its own data (to avoid double-counting)
      for (const selectedGeo of filters.geographies) {
        if (regionToCountriesMap[selectedGeo]?.includes(record.geography)) {
          // Only include child geography if the parent region has NO own data for this segment type
          if (!selectedGeosWithOwnData.has(selectedGeo)) {
            geoMatch = true
          }
          break
        }
      }

      // Include Global data when non-global geographies are selected
      // BUT only as a fallback when the selected geography has NO own data for this segment type
      // This handles cases where a segment type only exists under Global
      if (!geoMatch && record.geography === 'Global') {
        const hasNonGlobalSelection = filters.geographies.some(g => g !== 'Global')
        if (hasNonGlobalSelection) {
          // Only fall back to Global if ALL selected geographies lack their own data
          const allSelectedLackData = filters.geographies.every(g => !selectedGeosWithOwnData.has(g))
          if (allSelectedLackData) {
            geoMatch = true
          }
        }
      }
    }

    if (!geoMatch) {
      return false
    }
    
    // 2. Aggregation level filter - CRITICAL: Prevent double-counting
    // Use effectiveAggregationLevel (automatically determined or user-selected)
    if (effectiveAggregationLevel !== undefined && effectiveAggregationLevel !== null) {
      // When a specific level is selected, we need to include records that have data at that level
      const recordLevel = record.aggregation_level

      // For Level 2 (first segment level):
      // ONLY include records at level 2. Do NOT also include leaf children,
      // because parent nodes already contain the correct aggregated totals.
      // Children (level 3+) are only needed when user explicitly drills down.
      if (effectiveAggregationLevel === 2) {
        if (recordLevel === 2) {
          // Allow record at level 2 (aggregated parent OR leaf at level 2)
        } else {
          return false
        }
      } else {
        // For other levels, use strict matching
        if (recordLevel !== effectiveAggregationLevel) {
          // For leaf records, check if their hierarchy has a segment at the selected level
          if (record.is_aggregated === false) {
            const hierarchy = record.segment_hierarchy
            let hasSegmentAtLevel = false

            if (effectiveAggregationLevel === 3 && hierarchy.level_2 && hierarchy.level_2.trim() !== '') {
              hasSegmentAtLevel = true
            } else if (effectiveAggregationLevel === 4 && hierarchy.level_3 && hierarchy.level_3.trim() !== '') {
              hasSegmentAtLevel = true
            } else if (effectiveAggregationLevel === 5 && hierarchy.level_4 && hierarchy.level_4.trim() !== '') {
              hasSegmentAtLevel = true
            } else if (effectiveAggregationLevel === 6 && hierarchy.level_5 && hierarchy.level_5.trim() !== '') {
              hasSegmentAtLevel = true
            }

            if (!hasSegmentAtLevel) {
              return false
            }
          } else {
            return false
          }
        }
      }
    } else {
      // When aggregationLevel is null (showing "All Levels"), prevent double-counting
      // Strategy:
      // - If a PARENT segment is selected (like "Parenteral"), show LEAF records (Intravenous, etc.) NOT the aggregated parent
      // - If a LEAF segment is selected directly, show that leaf record
      // - If LEVEL 1 segments are selected directly (like "By Saturation", "By Structure"), show those aggregated records
      // - If no segments selected AND it's a regional segment type: Show all records (leaf and aggregated)
      // - If no segments selected AND it's NOT a regional segment type: Only show leaf records (to avoid double-counting)
      const hasSegmentFilter = (filters.advancedSegments && filters.advancedSegments.length > 0) ||
                               (filters.segments && filters.segments.length > 0)

      // Check if the user explicitly selected Level 1 segments
      // Level 1 segments are typically aggregation_level === 2 records where the segment name
      // matches exactly what the user selected (not a parent-child relationship)
      let selectedLevel1Segments: string[] = []
      if (filters.advancedSegments && filters.advancedSegments.length > 0) {
        selectedLevel1Segments = filters.advancedSegments
          .filter((seg: any) => seg.type === filters.segmentType)
          .map((seg: any) => seg.segment)
      } else if (filters.segments && filters.segments.length > 0) {
        selectedLevel1Segments = filters.segments
      }

      // Check if this record's segment is one of the explicitly selected segments
      const isExplicitlySelectedSegment = selectedLevel1Segments.includes(record.segment)

      if (record.is_aggregated === true) {
        // Aggregated (parent) records contain totals that overlap with their children.
        // To prevent double-counting:
        // - If user explicitly selected THIS segment, INCLUDE the parent total
        //   (children will be excluded below)
        // - Otherwise, exclude aggregated records
        if (isExplicitlySelectedSegment) {
          // User selected this exact parent segment - show its total
          // Allow through
        } else if (!isRegionalSegmentType) {
          return false
        }
      } else {
        // Leaf record - include it unless its parent is already included as an aggregated record
        if (selectedLevel1Segments.length > 0) {
          if (isRegionalSegmentType) {
            const regionalGeographies = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Middle East', 'Africa', 'ASEAN', 'SAARC Region', 'CIS Region', 'Global']
            const selectedAreGeographies = selectedLevel1Segments.some(seg => regionalGeographies.includes(seg))
            const selectedAreSegments = selectedLevel1Segments.some(seg => !regionalGeographies.includes(seg))

            if (selectedAreGeographies && !selectedAreSegments) {
              const belongsToSelectedGeography = selectedLevel1Segments.some(selectedSeg =>
                record.geography === selectedSeg
              )
              if (!belongsToSelectedGeography) {
                return false
              }
            } else {
              const belongsToSelectedSegment = selectedLevel1Segments.some(selectedSeg =>
                record.segment === selectedSeg
              )
              if (!belongsToSelectedSegment) {
                return false
              }
            }
          } else {
            // Check if this leaf's parent is one of the explicitly selected segments
            // If so, the aggregated parent record is already included - skip the leaf to avoid double-counting
            const hierarchy = record.segment_hierarchy
            const parentIsSelected = selectedLevel1Segments.some(selectedSeg =>
              hierarchy.level_1 === selectedSeg
            )

            if (parentIsSelected && !isExplicitlySelectedSegment) {
              // Parent aggregated record is already included - exclude this leaf child
              // BUT if this leaf IS the explicitly selected segment (flat segment with no children),
              // include it because there's no separate aggregated parent record for flat segments
              return false
            }

            // For other cases, check if this leaf belongs to any selected segment
            const belongsToSelectedSegment = selectedLevel1Segments.some(selectedSeg =>
              hierarchy.level_1 === selectedSeg ||
              hierarchy.level_2 === selectedSeg ||
              record.segment === selectedSeg
            )

            if (!belongsToSelectedSegment) {
              return false
            }
          }
        }
      }
    }
    
    // 3. Segment type filter - must match
    const segTypeMatch = record.segment_type === filters.segmentType
    if (!segTypeMatch) {
      return false
    }
    
    // 4. Business type filter - only apply if the record actually has B2B/B2C in its hierarchy
    let businessTypeMatch = true
    const recordBusinessType = record.segment_hierarchy?.level_1
    if (recordBusinessType === 'B2B' || recordBusinessType === 'B2C') {
      businessTypeMatch = recordBusinessType === filters.businessType
    }
    
    if (!businessTypeMatch) {
      return false
    }
    
    // 5. Segment filter - handle both advancedSegments and regular segments
    let segmentMatch = true

    // Special handling for "By Region" segment type
    // For "By Region", the selected "segment" is actually a geography name (like "North America")
    // and we need to match records where record.geography === selected segment
    const isRegionSegmentType = filters.segmentType === 'By Region' ||
                                filters.segmentType === 'By State' ||
                                filters.segmentType === 'By Country'

    // Check if we're using advancedSegments (multi-type selection)
    if (filters.advancedSegments && filters.advancedSegments.length > 0) {
      // Special case: Level 1 uses '__ALL_SEGMENTS__' marker
      if (effectiveAggregationLevel === 1) {
        // Level 1 represents all segments aggregated - don't filter by individual segments
        segmentMatch = true
      } else {
        // Check if this record matches any of the selected segment+type combinations
        segmentMatch = filters.advancedSegments.some(seg => {
          if (seg.type !== record.segment_type) {
            return false
          }

          // Direct match - exact segment name
          if (seg.segment === record.segment) {
            console.log('🔍 SEGMENT FILTER: Direct match:', { recordSegment: record.segment, selectedSegment: seg.segment })
            return true
          }

          // Special handling for "By Region" - match geography name as parent
          // When user selects "North America" for "By Region", include all records where geography="North America"
          if (isRegionSegmentType && seg.segment === record.geography) {
            console.log('🔍 SEGMENT FILTER: By Region geography match:', {
              recordGeography: record.geography,
              recordSegment: record.segment,
              selectedSegment: seg.segment
            })
            return true
          }

          // ALWAYS check hierarchy for parent segment matching
          // This handles cases like: User selects "Parenteral" but records have segment="Intravenous"
          // We need to include records where "Parenteral" is in their hierarchy
          const hierarchy = record.segment_hierarchy

          // Check if the selected segment is at any level in this record's hierarchy
          // This allows selecting a parent segment to include all its children
          const hierarchyMatch = hierarchy.level_1 === seg.segment ||
              hierarchy.level_2 === seg.segment ||
              hierarchy.level_3 === seg.segment ||
              hierarchy.level_4 === seg.segment ||
              (hierarchy.level_5 && hierarchy.level_5 === seg.segment)

          if (hierarchyMatch) {
            console.log('🔍 SEGMENT FILTER: Hierarchy match:', {
              recordSegment: record.segment,
              selectedSegment: seg.segment,
              level_1: hierarchy.level_1,
              level_2: hierarchy.level_2,
              is_aggregated: record.is_aggregated,
              aggregation_level: record.aggregation_level
            })
            return true
          }

          return false
        })
      }
    } else {
      // Regular segment filter (single-type selection)
      if (effectiveAggregationLevel === 1) {
        // Level 1 represents all segments aggregated - don't filter by individual segments
        segmentMatch = true
      } else if (filters.segments.length === 0) {
        // No segments selected - include all
        segmentMatch = true
      } else {
        // Check if any selected segment matches
        segmentMatch = filters.segments.some(selectedSegment => {
          // Direct match
          if (selectedSegment === record.segment) {
            return true
          }

          // Special handling for "By Region" - match geography name as parent
          // When user selects "North America" for "By Region", include all records where geography="North America"
          if (isRegionSegmentType && selectedSegment === record.geography) {
            console.log('🔍 SEGMENT FILTER: By Region geography match:', {
              recordGeography: record.geography,
              recordSegment: record.segment,
              selectedSegment
            })
            return true
          }

          // ALWAYS check hierarchy for parent segment matching
          // This handles cases like: User selects "Parenteral" but records have segment="Intravenous"
          const hierarchy = record.segment_hierarchy
          // Check if the selected segment is at any level in this record's hierarchy
          return (
            hierarchy.level_1 === selectedSegment ||
            hierarchy.level_2 === selectedSegment ||
            hierarchy.level_3 === selectedSegment ||
            hierarchy.level_4 === selectedSegment ||
            (hierarchy.level_5 && hierarchy.level_5 === selectedSegment)
          )
        })
      }
    }

    return segmentMatch
  })
  
  // Enhanced debug logging
  if (typeof window !== 'undefined') {
    const sampleRecord = data[0]
    if (sampleRecord) {
      const geoMatch = filters.geographies.length === 0 || filters.geographies.includes(sampleRecord.geography)
      const segTypeMatch = sampleRecord.segment_type === filters.segmentType
      const levelMatch = effectiveAggregationLevel === null || sampleRecord.aggregation_level === effectiveAggregationLevel
      
      // Check segment match
      let segmentMatchCheck = true
      if (filters.advancedSegments && filters.advancedSegments.length > 0) {
        if (effectiveAggregationLevel === 1) {
          segmentMatchCheck = true
        } else {
          segmentMatchCheck = filters.advancedSegments.some(seg => 
            seg.type === sampleRecord.segment_type && seg.segment === sampleRecord.segment
          )
        }
      } else {
        if (effectiveAggregationLevel === 1) {
          segmentMatchCheck = true
        } else {
          segmentMatchCheck = filters.segments.length === 0 || filters.segments.includes(sampleRecord.segment)
        }
      }
      
      console.log('🔍 Filter Debug:', {
        totalRecords: data.length,
        filteredRecords: filtered.length,
        filters: {
          geographies: filters.geographies,
          segments: filters.segments,
          segmentType: filters.segmentType,
          aggregationLevel: filters.aggregationLevel,
          advancedSegments: filters.advancedSegments?.map(s => ({ type: s.type, segment: s.segment }))
        },
        sampleRecord: {
          geography: sampleRecord.geography,
          segment: sampleRecord.segment,
          segment_type: sampleRecord.segment_type,
          aggregation_level: sampleRecord.aggregation_level,
          is_aggregated: sampleRecord.is_aggregated
        },
        sampleRecordMatches: {
          geoMatch,
          segTypeMatch,
          levelMatch,
          segmentMatch: segmentMatchCheck
        },
        // Show records at selected level
        recordsAtSelectedLevel: effectiveAggregationLevel !== null 
          ? data
              .filter(r => {
                // First check aggregation level
                if (r.aggregation_level !== effectiveAggregationLevel) {
                  return false
                }
                // Then check segment type
                if (r.segment_type !== filters.segmentType) {
                  return false
                }
                // Then check geography if selected
                if (filters.geographies.length > 0 && !filters.geographies.includes(r.geography)) {
                  return false
                }
                return true
              })
              .slice(0, 10)
              .map(r => ({
                geography: r.geography,
                segment: r.segment,
                segment_type: r.segment_type,
                aggregation_level: r.aggregation_level
              }))
          : [],
        // Show records matching geography and segment type
        recordsMatchingGeoAndType: data
          .filter(r => 
            (filters.geographies.length === 0 || filters.geographies.includes(r.geography)) &&
            r.segment_type === filters.segmentType
          )
          .slice(0, 10)
          .map(r => ({
            geography: r.geography,
            segment: r.segment,
            aggregation_level: r.aggregation_level
          }))
      })
    }
    
    // Additional debug: Log first few records that match aggregation level
    if (effectiveAggregationLevel !== null) {
      const matchingLevelRecords = data.filter(r => 
        r.aggregation_level === effectiveAggregationLevel &&
        r.segment_type === filters.segmentType &&
        (filters.geographies.length === 0 || filters.geographies.includes(r.geography))
      ).slice(0, 5)
      
      console.log('🔍 Records at selected level:', {
        level: effectiveAggregationLevel,
        count: matchingLevelRecords.length,
        samples: matchingLevelRecords.map(r => ({
          geo: r.geography,
          segment: r.segment,
          segType: r.segment_type,
          level: r.aggregation_level
        })),
        selectedSegments: filters.advancedSegments?.map(s => s.segment) || filters.segments
      })
    }
    
    // Enhanced debug for Level 1
    if (effectiveAggregationLevel === 1) {
      console.log('🔍 Level 1 Filter Debug:', {
        totalRecords: data.length,
        filteredRecords: filtered.length,
        filters: {
          geographies: filters.geographies,
          segmentType: filters.segmentType,
          aggregationLevel: effectiveAggregationLevel
        },
        filteredRecordsDetails: filtered.slice(0, 5).map(r => ({
          geo: r.geography,
          segment: r.segment,
          level: r.aggregation_level,
          isAggregated: r.is_aggregated
        })),
        allLevel1Records: data.filter(r => r.aggregation_level === 1).length,
        level1WithCorrectSegmentType: data.filter(r => 
          r.aggregation_level === 1 && r.segment_type === filters.segmentType
        ).length
      })
    }
  }
  
  return filtered
}

/**
 * Prepare data for grouped bar chart (Recharts format) with stacking support
 */
export function prepareGroupedBarData(
  records: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] },
  byRegionRecords?: DataRecord[],
  geographyCountries?: Record<string, string[]>
): ChartDataPoint[] {
  const { yearRange, viewMode, geographies, segments, aggregationLevel } = filters
  const [startYear, endYear] = yearRange

  // Get selected segments for aggregation
  const advancedSegments = filters.advancedSegments || []
  const selectedSegmentNames = advancedSegments
    .filter((seg: any) => seg.type === filters.segmentType)
    .map((seg: any) => seg.segment)

  // Determine effective aggregation level (same logic as filterData)
  // This ensures chart data preparation uses the same level detection
  let effectiveAggregationLevel = aggregationLevel

  // IMPORTANT: When user has EXPLICITLY selected segments (via Add Segment button),
  // we should NOT apply automatic Level 2 aggregation - we want to show the sub-segments individually
  const hasUserSelectedSegments = selectedSegmentNames.length > 0

  if (effectiveAggregationLevel === null || effectiveAggregationLevel === undefined) {
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    const hasSegmentsForCurrentType = segmentsFromSameType.length > 0

    if (!hasSegmentsForCurrentType) {
      // No segments selected for this segment type - default to Level 2 (show parent segments)
      effectiveAggregationLevel = 2
    } else {
      // User selected specific segments - don't force Level 2 aggregation
      // This allows showing sub-segments when a parent is selected
      effectiveAggregationLevel = null
    }
  }

  // Generate year range
  const years: number[] = []
  for (let year = startYear; year <= endYear; year++) {
    years.push(year)
  }

  // Special handling for Level 1: Show total aggregation, not individual segments
  // When Level 1 is selected, all records should have segment === '__ALL_SEGMENTS__'
  // We should group by geography (or show a single total) instead of by segment
  const isLevel1 = effectiveAggregationLevel === 1

  // Special handling for Level 2: Aggregate by Level 1 segment (e.g., Parenteral, Oral, Topical)
  // This groups sub-segments under their parent segment
  const isLevel2 = effectiveAggregationLevel === 2

  // Check if user selected a parent segment (like "Parenteral")
  // If so, we need to aggregate all child records under that parent
  const shouldAggregateBySelectedSegment = selectedSegmentNames.length > 0 && viewMode === 'segment-mode'

  // Determine if we need stacked bars
  const needsStacking = (viewMode === 'segment-mode' && geographies.length > 1) ||
                        (viewMode === 'geography-mode' && segments.length > 1)
  
  // Transform into Recharts format
  return years.map(year => {
    const dataPoint: ChartDataPoint = { year }
    
    // Special case: Level 1 aggregation
    if (isLevel1) {
      // For Level 1, group by geography (or show single total)
      // All records have segment === '__ALL_SEGMENTS__', so grouping by segment makes no sense
      const aggregatedData: Record<string, number> = {}

      records.forEach(record => {
        // Group by geography for Level 1
        const key = record.geography
        if (!aggregatedData[key]) {
          aggregatedData[key] = 0
        }
        aggregatedData[key] += record.time_series[year] || 0
      })

      Object.entries(aggregatedData).forEach(([key, value]) => {
        dataPoint[key] = value
      })

      return dataPoint
    }

    // Special case: Level 2 aggregation - aggregate by Level 1 segment (e.g., Parenteral, Oral)
    // This ensures we show parent segments, not sub-segments
    // BUT: Skip this when user has explicitly selected segments - show sub-segments individually
    // ALSO: Skip this in geography-mode - we want to aggregate by geography, not segment
    if (isLevel2 && !hasUserSelectedSegments && viewMode === 'segment-mode') {
      const aggregatedData: Record<string, number> = {}

      // Build a child-to-parent mapping from all records
      // This maps sub-segments to their parent (e.g., "Intravenous" -> "Parenteral")
      const childToParentMap = new Map<string, string>()

      // First pass: identify parent-child relationships from the segment_hierarchy
      // For sub-segments like Intravenous, level_1 should be the parent (Parenteral)
      // But we need to verify this by checking which segments have children
      const segmentsWithChildren = new Set<string>()
      const allSegments = new Set<string>()

      records.forEach(record => {
        const segment = record.segment
        allSegments.add(segment)

        // Check segment_hierarchy - level_1 is the first segment in the path
        // level_2 would be the second segment (sub-segment)
        const level1 = record.segment_hierarchy?.level_1
        const level2 = record.segment_hierarchy?.level_2

        // If this record has both level_1 and level_2, then level_1 is a parent
        if (level1 && level2 && level1.trim() !== '' && level2.trim() !== '') {
          segmentsWithChildren.add(level1)
          // Map the current segment to its level_1 parent if it's different
          if (segment !== level1) {
            childToParentMap.set(segment, level1)
          }
        }
      })

      // Debug logging for Level 2 aggregation
      if (year === years[0]) {
        console.log('🔄 Level 2 Aggregation Debug:', {
          recordCount: records.length,
          allSegments: Array.from(allSegments),
          segmentsWithChildren: Array.from(segmentsWithChildren),
          childToParentMap: Object.fromEntries(childToParentMap),
          sampleRecords: records.slice(0, 5).map(r => ({
            segment: r.segment,
            level1: r.segment_hierarchy?.level_1,
            level2: r.segment_hierarchy?.level_2,
            isAggregated: r.is_aggregated,
            aggLevel: r.aggregation_level
          }))
        })
      }

      records.forEach(record => {
        let key: string
        const segment = record.segment

        // If this segment has a parent mapping, use the parent
        if (childToParentMap.has(segment)) {
          key = childToParentMap.get(segment)!
        } else if (record.is_aggregated && record.aggregation_level === 2) {
          // If record is already at level 2 (aggregated parent), use its segment name
          key = segment
        } else {
          // For segments without parents (like Oral, Topical), use their own name
          key = segment
        }

        if (!aggregatedData[key]) {
          aggregatedData[key] = 0
        }
        aggregatedData[key] += record.time_series[year] || 0
      })

      // Debug the final aggregated keys
      if (year === years[0]) {
        console.log('🔄 Level 2 Aggregated Keys:', Object.keys(aggregatedData))
      }

      Object.entries(aggregatedData).forEach(([key, value]) => {
        dataPoint[key] = value
      })

      return dataPoint
    }

    if (needsStacking) {
      // Stacked bar chart logic
      if (viewMode === 'segment-mode') {
        // Stack geographies within each segment bar
        // Primary grouping: segments (each becomes a bar)
        // Secondary grouping: geographies (stacked within each bar)
        
        // When aggregationLevel is null, prevent double-counting by preferring aggregated records
        const segmentAggregatedMap = new Map<string, Set<string>>() // segment -> set of geographies with aggregated records
        if (aggregationLevel === null) {
          records.forEach(record => {
            if (record.is_aggregated === true) {
              if (!segmentAggregatedMap.has(record.segment)) {
                segmentAggregatedMap.set(record.segment, new Set())
              }
              segmentAggregatedMap.get(record.segment)!.add(record.geography)
            }
          })
        }
        
        const segmentMap = new Map<string, Map<string, number>>()

    records.forEach(record => {
          const segment = record.segment
          const geography = record.geography

          // Prevent double-counting: if this segment+geography has an aggregated record, skip leaf records
          if (aggregationLevel === null && segmentAggregatedMap.has(segment)) {
            const geoSet = segmentAggregatedMap.get(segment)!
            if (geoSet.has(geography) && record.is_aggregated === false) {
              return // Skip this leaf record, use the aggregated one instead
            }
          }

          // Handle Global data mapping for segment-mode stacking:
          // When data is Global but user selected non-Global geographies,
          // distribute Global data proportionally based on "By Region" market shares
          if (geography === 'Global' && !geographies.includes('Global')) {
            const selectedNonGlobal = geographies.filter(g => g !== 'Global')
            if (selectedNonGlobal.length > 0) {
              const globalValue = record.time_series[year] || 0
              const proportions = getGeographyProportions(
                byRegionRecords || [], selectedNonGlobal, year, geographyCountries
              )

              selectedNonGlobal.forEach(geo => {
                const share = proportions.get(geo) || (1.0 / selectedNonGlobal.length)
                if (!segmentMap.has(segment)) {
                  segmentMap.set(segment, new Map())
                }
                const geoMap = segmentMap.get(segment)!
                const currentValue = geoMap.get(geo) || 0
                geoMap.set(geo, currentValue + globalValue * share)
              })
              return // Skip normal processing
            }
          }

          if (!segmentMap.has(segment)) {
            segmentMap.set(segment, new Map())
          }

          const geoMap = segmentMap.get(segment)!
          const currentValue = geoMap.get(geography) || 0
          const recordValue = record.time_series[year] || 0
          geoMap.set(geography, currentValue + recordValue)
        })

        // Create stacked data keys: segment_geography
        segmentMap.forEach((geoMap, segment) => {
          geoMap.forEach((value, geography) => {
            const key = `${segment}::${geography}`
            dataPoint[key] = value
          })
        })
        
      } else if (viewMode === 'geography-mode') {
        // Stack segments within each geography bar
        // Primary grouping: geographies (each becomes a bar)
        // Secondary grouping: segments (stacked within each bar)
        
        // When aggregationLevel is null, prevent double-counting by preferring aggregated records
        const geoSegmentAggregatedMap = new Map<string, Set<string>>() // geography -> set of segments with aggregated records
        if (aggregationLevel === null) {
          records.forEach(record => {
            if (record.is_aggregated === true) {
              if (!geoSegmentAggregatedMap.has(record.geography)) {
                geoSegmentAggregatedMap.set(record.geography, new Set())
              }
              geoSegmentAggregatedMap.get(record.geography)!.add(record.segment)
            }
          })
        }
        
        const geoMap = new Map<string, Map<string, number>>()

        // Region to countries mapping for parent geography aggregation
        const regionToCountriesStacked: Record<string, string[]> = {
          'North America': ['U.S.', 'Canada'],
          'Europe': ['U.K.', 'Germany', 'Italy', 'France', 'Spain', 'Russia', 'Rest of Europe'],
          'Asia Pacific': ['China', 'India', 'Japan', 'South Korea', 'ASEAN', 'Australia', 'Rest of Asia Pacific'],
          'Latin America': ['Brazil', 'Argentina', 'Mexico', 'Rest of Latin America'],
          'Middle East & Africa': ['GCC', 'South Africa', 'Rest of Middle East & Africa']
        }

        records.forEach(record => {
          let geography = record.geography
          const segment = record.segment

          // Handle Global data mapping to selected geographies
          // When data only exists at Global level but user selected regional/country geographies,
          // distribute Global data proportionally based on "By Region" market shares
          if (record.geography === 'Global' && !geographies.includes('Global')) {
            const selectedNonGlobal = geographies.filter(g => g !== 'Global')
            if (selectedNonGlobal.length > 0) {
              const globalValue = record.time_series[year] || 0
              const proportions = getGeographyProportions(
                byRegionRecords || [], selectedNonGlobal, year, geographyCountries
              )

              selectedNonGlobal.forEach(geo => {
                const share = proportions.get(geo) || (1.0 / selectedNonGlobal.length)
                if (!geoMap.has(geo)) {
                  geoMap.set(geo, new Map())
                }
                const segMapForGeo = geoMap.get(geo)!
                const curVal = segMapForGeo.get(segment) || 0
                segMapForGeo.set(segment, curVal + globalValue * share)
              })
              return // Skip normal processing for this Global record
            }
          }

          // Map child geography to parent if parent is selected
          for (const [region, countries] of Object.entries(regionToCountriesStacked)) {
            if (countries.includes(geography) && geographies.includes(region)) {
              geography = region
              break
            }
          }

          // Prevent double-counting: if this geography+segment has an aggregated record, skip leaf records
          if (aggregationLevel === null && geoSegmentAggregatedMap.has(geography)) {
            const segmentSet = geoSegmentAggregatedMap.get(geography)!
            if (segmentSet.has(segment) && record.is_aggregated === false) {
              return // Skip this leaf record, use the aggregated one instead
            }
          }

          if (!geoMap.has(geography)) {
            geoMap.set(geography, new Map())
          }

          const segmentMap = geoMap.get(geography)!
          const currentValue = segmentMap.get(segment) || 0
          const recordValue = record.time_series[year] || 0
          segmentMap.set(segment, currentValue + recordValue)
          })

        // Create stacked data keys: geography_segment
        geoMap.forEach((segmentMap, geography) => {
          segmentMap.forEach((value, segment) => {
            const key = `${geography}::${segment}`
            dataPoint[key] = value
          })
        })
          }
        } else {
      // Original non-stacked logic
      const aggregatedData: Record<string, number> = {}
      
      // When aggregationLevel is null and grouping by segment, prevent double-counting
      // by preferring aggregated records over leaf records for the same segment
      const segmentAggregatedMap = new Map<string, boolean>()
      if (aggregationLevel === null && viewMode === 'segment-mode') {
        // First pass: identify which segments have aggregated records
        records.forEach(record => {
          if (record.is_aggregated === true) {
            segmentAggregatedMap.set(record.segment, true)
          }
        })
      }
      
      records.forEach(record => {
        let key: string
        
        // For Level 1, always group by geography (total aggregation per geography)
        if (isLevel1) {
          key = record.geography
        } else if (viewMode === 'segment-mode') {
          key = record.segment
          
          // Prevent double-counting: if this segment has an aggregated record, skip leaf records
          if (aggregationLevel === null && segmentAggregatedMap.has(key) && record.is_aggregated === false) {
            return // Skip this leaf record, use the aggregated one instead
          }
        } else if (viewMode === 'geography-mode') {
          // In geography mode, aggregate child geographies under their parent
          // if the parent is selected (e.g., U.S. + Canada data shown as "North America")
          const regionToCountries: Record<string, string[]> = {
            'North America': ['U.S.', 'Canada'],
            'Europe': ['U.K.', 'Germany', 'Italy', 'France', 'Spain', 'Russia', 'Rest of Europe'],
            'Asia Pacific': ['China', 'India', 'Japan', 'South Korea', 'ASEAN', 'Australia', 'Rest of Asia Pacific'],
            'Latin America': ['Brazil', 'Argentina', 'Mexico', 'Rest of Latin America'],
            'Middle East & Africa': ['GCC', 'South Africa', 'Rest of Middle East & Africa']
          }

          // Check if this record's geography should be aggregated under a parent
          let mappedGeo = record.geography

          // If this is Global data and non-Global geographies are selected,
          // map Global to each selected geography proportionally based on "By Region" data
          if (record.geography === 'Global' && !geographies.includes('Global')) {
            const selectedNonGlobal = geographies.filter(g => g !== 'Global')
            if (selectedNonGlobal.length > 0) {
              const globalValue = record.time_series[year] || 0
              const proportions = getGeographyProportions(
                byRegionRecords || [], selectedNonGlobal, year, geographyCountries
              )

              selectedNonGlobal.forEach(geo => {
                const share = proportions.get(geo) || (1.0 / selectedNonGlobal.length)
                if (!aggregatedData[geo]) {
                  aggregatedData[geo] = 0
                }
                aggregatedData[geo] += globalValue * share
              })
              return // Skip the normal aggregation below since we handled it
            }
          }

          for (const [region, countries] of Object.entries(regionToCountries)) {
            if (countries.includes(record.geography) && geographies.includes(region)) {
              mappedGeo = region
              break
            }
          }
          key = mappedGeo
        } else if (viewMode === 'matrix') {
          key = `${record.geography}::${record.segment}`
        } else {
          key = record.geography
        }
        
        if (!aggregatedData[key]) {
          aggregatedData[key] = 0
        }
        aggregatedData[key] += record.time_series[year] || 0
      })
      
      Object.entries(aggregatedData).forEach(([key, value]) => {
        dataPoint[key] = value
      })
    }
    
    return dataPoint
  })
}

/**
 * Prepare data for line chart (multi-series)
 */
export function prepareLineChartData(
  records: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] },
  byRegionRecords?: DataRecord[],
  geographyCountries?: Record<string, string[]>
): ChartDataPoint[] {
  const { yearRange, viewMode, aggregationLevel } = filters
  const [startYear, endYear] = yearRange

  // Get selected segments for aggregation
  const advancedSegments = filters.advancedSegments || []
  const selectedSegmentNames = advancedSegments
    .filter((seg: any) => seg.type === filters.segmentType)
    .map((seg: any) => seg.segment)

  // IMPORTANT: When user has EXPLICITLY selected segments (via Add Segment button),
  // we should NOT apply automatic Level 2 aggregation - we want to show the sub-segments individually
  const hasUserSelectedSegments = selectedSegmentNames.length > 0

  // Determine effective aggregation level (same logic as filterData and prepareGroupedBarData)
  let effectiveAggregationLevel = aggregationLevel
  if (effectiveAggregationLevel === null || effectiveAggregationLevel === undefined) {
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    const hasSegmentsForCurrentType = segmentsFromSameType.length > 0

    if (!hasSegmentsForCurrentType) {
      // No segments selected for this segment type - default to Level 2 (show parent segments)
      effectiveAggregationLevel = 2
    } else {
      // User selected specific segments - don't force Level 2 aggregation
      // This allows showing sub-segments when a parent is selected
      effectiveAggregationLevel = null
    }
  }

  // Only apply Level 2 aggregation when user hasn't explicitly selected segments
  const isLevel2 = effectiveAggregationLevel === 2 && !hasUserSelectedSegments
  const shouldAggregateBySelectedSegment = false // Disabled - we want to show sub-segments individually

  // Build child-to-parent mapping for Level 2 aggregation
  const childToParentMap = new Map<string, string>()
  if (isLevel2 && viewMode === 'segment-mode') {
    records.forEach(record => {
      const level1 = record.segment_hierarchy?.level_1
      const level2 = record.segment_hierarchy?.level_2
      const segment = record.segment

      if (level1 && level2 && level1.trim() !== '' && level2.trim() !== '') {
        if (segment !== level1) {
          childToParentMap.set(segment, level1)
        }
      }
    })
  }

  // Generate year range
  const years: number[] = []
  for (let year = startYear; year <= endYear; year++) {
    years.push(year)
  }

  // Check if user explicitly selected Level 1 segments (like "By Saturation", "By Structure")
  // In this case, we want to show each selected segment as a separate line
  const hasExplicitLevel1Selection = selectedSegmentNames.length > 0

  // Transform into Recharts format for line charts
  // Line charts always aggregate data by the primary dimension
  return years.map(year => {
    const dataPoint: ChartDataPoint = { year }

    // Group data by the dimension we want to show as lines
    const aggregated = new Map<string, number>()

    // Track which aggregated records we've seen for each selected segment
    const usedAggregatedRecords = new Map<string, boolean>()

    records.forEach(record => {
      let key: string

      if (viewMode === 'segment-mode') {
        // When Level 1 segments are explicitly selected, group by the selected segment
        // This ensures each selected Level 1 segment appears as a separate line
        if (hasExplicitLevel1Selection) {
          // Check if this record matches one of the selected segments
          const matchedSegment = selectedSegmentNames.find(seg => {
            // Direct match
            if (record.segment === seg) return true
            // Hierarchy match - if this is a child record of a selected segment
            const hierarchy = record.segment_hierarchy
            return hierarchy.level_1 === seg || hierarchy.level_2 === seg
          })

          if (matchedSegment) {
            // If this is an aggregated record for a selected segment, use its value directly
            if (record.is_aggregated && selectedSegmentNames.includes(record.segment)) {
              key = record.segment
              // Mark that we're using the aggregated record for this segment
              usedAggregatedRecords.set(key, true)
            } else {
              // For child records, group under their parent (the selected segment)
              // But only if we haven't already used an aggregated record for this segment
              if (usedAggregatedRecords.has(matchedSegment)) {
                // Skip - we already have the aggregated value
                return
              }
              key = matchedSegment
            }
          } else {
            // No match - skip this record
            return
          }
        } else if (shouldAggregateBySelectedSegment && !isLevel2) {
          // If user selected specific segment(s), aggregate by those
          const hierarchy = record.segment_hierarchy
          let matchedSegment: string | null = null

          for (const selectedSeg of selectedSegmentNames) {
            if (record.segment === selectedSeg ||
                hierarchy.level_1 === selectedSeg ||
                hierarchy.level_2 === selectedSeg ||
                hierarchy.level_3 === selectedSeg ||
                hierarchy.level_4 === selectedSeg ||
                hierarchy.level_5 === selectedSeg) {
              matchedSegment = selectedSeg
              break
            }
          }

          key = matchedSegment || record.segment
        } else if (isLevel2 && childToParentMap.has(record.segment)) {
          // For Level 2, map sub-segments to their parent
          key = childToParentMap.get(record.segment)!
        } else {
          key = record.segment
        }
      } else if (viewMode === 'geography-mode') {
        // Lines represent geographies (aggregate across segments)
        // Map child geographies to their parent if parent is selected
        const regionToCountriesLine: Record<string, string[]> = {
          'North America': ['U.S.', 'Canada'],
          'Europe': ['U.K.', 'Germany', 'Italy', 'France', 'Spain', 'Russia', 'Rest of Europe'],
          'Asia Pacific': ['China', 'India', 'Japan', 'South Korea', 'ASEAN', 'Australia', 'Rest of Asia Pacific'],
          'Latin America': ['Brazil', 'Argentina', 'Mexico', 'Rest of Latin America'],
          'Middle East & Africa': ['GCC', 'South Africa', 'Rest of Middle East & Africa']
        }

        let mappedGeo = record.geography

        // If this is Global data and non-Global geographies are selected,
        // map Global proportionally based on "By Region" market shares
        if (record.geography === 'Global' && !filters.geographies.includes('Global')) {
          const selectedNonGlobal = filters.geographies.filter(g => g !== 'Global')
          if (selectedNonGlobal.length > 0) {
            const globalValue = record.time_series[year] || 0
            const proportions = getGeographyProportions(
              byRegionRecords || [], selectedNonGlobal, year, geographyCountries
            )

            selectedNonGlobal.forEach(geo => {
              const share = proportions.get(geo) || (1.0 / selectedNonGlobal.length)
              const currentVal = aggregated.get(geo) || 0
              aggregated.set(geo, currentVal + globalValue * share)
            })
            return // Skip the normal aggregation below since we handled it
          }
        }

        for (const [region, countries] of Object.entries(regionToCountriesLine)) {
          if (countries.includes(record.geography) && filters.geographies.includes(region)) {
            mappedGeo = region
            break
          }
        }
        key = mappedGeo
      } else if (viewMode === 'matrix') {
        // Lines represent geography-segment combinations
        key = `${record.geography}::${record.segment}`
      } else {
        // Default to geography
        key = record.geography
      }

      const currentValue = aggregated.get(key) || 0
      const recordValue = record.time_series[year] || 0
      aggregated.set(key, currentValue + recordValue)
    })

    // Add aggregated values to dataPoint
    aggregated.forEach((value, key) => {
      dataPoint[key] = value
    })

    return dataPoint
  })
}

/**
 * Prepare data for heatmap
 */
export function prepareHeatmapData(
  records: DataRecord[],
  year: number
): HeatmapCell[] {
  const cells: HeatmapCell[] = []
  
  records.forEach(record => {
    // time_series uses number keys (years as numbers)
    const value = record.time_series[year] || 0
    
    cells.push({
      geography: record.geography,
      segment: record.segment,
      value,
      displayValue: value.toFixed(2)
    })
  })
  
  return cells
}

/**
 * Prepare data for comparison table
 */
export function prepareTableData(
  records: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] }
): ComparisonTableRow[] {
  const { yearRange, viewMode, aggregationLevel } = filters
  const [startYear, endYear] = yearRange

  // Get selected segments
  const advancedSegments = filters.advancedSegments || []
  const selectedSegmentNames = advancedSegments
    .filter((seg: any) => seg.type === filters.segmentType)
    .map((seg: any) => seg.segment)

  // IMPORTANT: When user has EXPLICITLY selected segments (via Add Segment button),
  // we should NOT apply automatic Level 2 aggregation - we want to show the sub-segments individually
  const hasUserSelectedSegments = selectedSegmentNames.length > 0

  // Determine effective aggregation level
  let effectiveAggregationLevel = aggregationLevel
  if (effectiveAggregationLevel === null || effectiveAggregationLevel === undefined) {
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    const hasSegmentsForCurrentType = segmentsFromSameType.length > 0

    if (!hasSegmentsForCurrentType) {
      effectiveAggregationLevel = 2
    } else {
      // User selected specific segments - don't force Level 2 aggregation
      effectiveAggregationLevel = null
    }
  }

  // Only apply Level 2 aggregation when user hasn't explicitly selected segments
  const isLevel2 = effectiveAggregationLevel === 2 && !hasUserSelectedSegments

  // Build child-to-parent mapping for Level 2 aggregation
  const childToParentMap = new Map<string, string>()
  if (isLevel2 && viewMode === 'segment-mode') {
    records.forEach(record => {
      const level1 = record.segment_hierarchy?.level_1
      const level2 = record.segment_hierarchy?.level_2
      const segment = record.segment

      if (level1 && level2 && level1.trim() !== '' && level2.trim() !== '') {
        if (segment !== level1) {
          childToParentMap.set(segment, level1)
        }
      }
    })
  }

  // If Level 2 aggregation in segment mode, aggregate data by parent segment
  if (isLevel2 && viewMode === 'segment-mode' && childToParentMap.size > 0) {
    // Aggregate records by geography + parent segment
    const aggregatedMap = new Map<string, {
      geography: string
      segment: string
      timeSeries: Record<number, number>
      cagrSum: number
      count: number
    }>()

    records.forEach(record => {
      let segmentKey = record.segment
      if (childToParentMap.has(segmentKey)) {
        segmentKey = childToParentMap.get(segmentKey)!
      }

      const key = `${record.geography}::${segmentKey}`

      if (!aggregatedMap.has(key)) {
        aggregatedMap.set(key, {
          geography: record.geography,
          segment: segmentKey,
          timeSeries: {},
          cagrSum: 0,
          count: 0
        })
      }

      const agg = aggregatedMap.get(key)!
      // Sum up time series values
      for (let year = startYear; year <= endYear; year++) {
        agg.timeSeries[year] = (agg.timeSeries[year] || 0) + (record.time_series[year] || 0)
      }
      agg.cagrSum += record.cagr
      agg.count++
    })

    // Convert aggregated data to table rows
    return Array.from(aggregatedMap.values()).map(agg => {
      const baseValue = agg.timeSeries[startYear] || 0
      const forecastValue = agg.timeSeries[endYear] || 0
      const growth = baseValue > 0
        ? ((forecastValue - baseValue) / baseValue) * 100
        : 0

      const timeSeries: number[] = []
      for (let year = startYear; year <= endYear; year++) {
        timeSeries.push(agg.timeSeries[year] || 0)
      }

      return {
        geography: agg.geography,
        segment: agg.segment,
        baseYear: baseValue,
        forecastYear: forecastValue,
        cagr: agg.count > 0 ? agg.cagrSum / agg.count : 0, // Average CAGR
        growth,
        timeSeries
      }
    })
  }

  // Default: return records as-is
  return records.map(record => {
    // time_series uses number keys (years as numbers)
    const baseValue = record.time_series[filters.yearRange[0]] || 0
    const forecastValue = record.time_series[filters.yearRange[1]] || 0
    const growth = baseValue > 0
      ? ((forecastValue - baseValue) / baseValue) * 100
      : 0

    // Extract time series for sparkline
    const timeSeries: number[] = []
    for (let year = startYear; year <= endYear; year++) {
      timeSeries.push(record.time_series[year] || 0)
    }

    return {
      geography: record.geography,
      segment: record.segment,
      baseYear: baseValue,
      forecastYear: forecastValue,
      cagr: record.cagr,
      growth,
      timeSeries
    }
  })
}

/**
 * Get unique geographies from filtered data
 */
export function getUniqueGeographies(records: DataRecord[]): string[] {
  const geos = new Set<string>()
  records.forEach(record => geos.add(record.geography))
  return Array.from(geos)
}

/**
 * Get unique segments from filtered data
 * Returns only parent segments if they exist, otherwise returns leaf segments
 */
export function getUniqueSegments(records: DataRecord[]): string[] {
  const segments = new Set<string>()
  const parentSegments = new Set<string>()
  const childSegments = new Map<string, string[]>() // parent -> children mapping
  
  // First pass: identify all parent and leaf segments
  records.forEach(record => {
    if (record.segment_level === 'parent') {
      parentSegments.add(record.segment)
    } else {
      // Check if this leaf has a parent in the hierarchy
      const parentInHierarchy = record.segment_hierarchy.level_2
      if (parentInHierarchy && parentInHierarchy !== record.segment) {
        if (!childSegments.has(parentInHierarchy)) {
          childSegments.set(parentInHierarchy, [])
        }
        childSegments.get(parentInHierarchy)!.push(record.segment)
      }
    }
  })
  
  // Second pass: add segments to the result
  records.forEach(record => {
    // If this is a parent segment, always include it
    if (record.segment_level === 'parent') {
      segments.add(record.segment)
    } else {
      // For leaf segments, only add if their parent is NOT in the parent segments set
      const parentInHierarchy = record.segment_hierarchy.level_2
      if (!parentSegments.has(parentInHierarchy)) {
        segments.add(record.segment)
      }
    }
  })
  
  return Array.from(segments)
}

/**
 * Prepare data for waterfall chart
 * Shows contribution breakdown from start to end value
 */
export function prepareWaterfallData(
  records: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] }
): Array<{ name: string; value: number; type: 'start' | 'positive' | 'negative' | 'end' }> {
  const [startYear, endYear] = filters.yearRange

  // Get selected segments
  const advancedSegments = filters.advancedSegments || []
  const selectedSegmentNames = advancedSegments
    .filter((seg: any) => seg.type === filters.segmentType)
    .map((seg: any) => seg.segment)

  // IMPORTANT: When user has EXPLICITLY selected segments (via Add Segment button),
  // we should NOT apply automatic Level 2 aggregation - we want to show the sub-segments individually
  const hasUserSelectedSegments = selectedSegmentNames.length > 0

  // Determine effective aggregation level
  let effectiveAggregationLevel = filters.aggregationLevel
  if (effectiveAggregationLevel === null || effectiveAggregationLevel === undefined) {
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    const hasSegmentsForCurrentType = segmentsFromSameType.length > 0

    if (!hasSegmentsForCurrentType) {
      effectiveAggregationLevel = 2
    } else {
      // User selected specific segments - don't force Level 2 aggregation
      effectiveAggregationLevel = null
    }
  }

  // Only apply Level 2 aggregation when user hasn't explicitly selected segments
  const isLevel2 = effectiveAggregationLevel === 2 && !hasUserSelectedSegments

  // Build child-to-parent mapping for Level 2 aggregation
  const childToParentMap = new Map<string, string>()
  if (isLevel2 && filters.viewMode === 'segment-mode') {
    records.forEach(record => {
      const level1 = record.segment_hierarchy?.level_1
      const level2 = record.segment_hierarchy?.level_2
      const segment = record.segment

      if (level1 && level2 && level1.trim() !== '' && level2.trim() !== '') {
        if (segment !== level1) {
          childToParentMap.set(segment, level1)
        }
      }
    })
  }

  // Group records by the dimension we're analyzing
  const groupKey = filters.viewMode === 'segment-mode' ? 'segment' : 'geography'

  // Calculate starting total
  let startTotal = 0
  records.forEach(record => {
    startTotal += record.time_series[startYear] || 0
  })

  // Group and calculate contributions
  const grouped = new Map<string, number>()
  records.forEach(record => {
    let key = record[groupKey]

    // For Level 2 segment mode, map sub-segments to their parent
    if (isLevel2 && groupKey === 'segment' && childToParentMap.has(key)) {
      key = childToParentMap.get(key)!
    }

    const startValue = record.time_series[startYear] || 0
    const endValue = record.time_series[endYear] || 0
    const change = endValue - startValue

    grouped.set(key, (grouped.get(key) || 0) + change)
  })
  
  // Build waterfall data
  const waterfallData: Array<{ name: string; value: number; type: 'start' | 'positive' | 'negative' | 'end' }> = []
  
  // Starting value
  waterfallData.push({
    name: `Start (${startYear})`,
    value: startTotal,
    type: 'start'
  })
  
  // Sort contributions by absolute value (largest first)
  const sortedContributions = Array.from(grouped.entries())
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  
  // Add positive contributions
  sortedContributions.forEach(([name, change]) => {
    if (change > 0) {
      waterfallData.push({
        name,
        value: change,
        type: 'positive'
      })
    }
  })
  
  // Add negative contributions
  sortedContributions.forEach(([name, change]) => {
    if (change < 0) {
      waterfallData.push({
        name,
        value: Math.abs(change),
        type: 'negative'
      })
    }
  })
  
  // Calculate ending total
  let endTotal = 0
  records.forEach(record => {
    endTotal += record.time_series[endYear] || 0
  })
  
  // Ending value
  waterfallData.push({
    name: `End (${endYear})`,
    value: endTotal,
    type: 'end'
  })
  
  return waterfallData
}

/**
 * Prepare data for charts with multiple aggregation levels
 * Shows the most granular level available for each segment without double-counting
 * This allows displaying data from different levels together on one graph
 */
export function prepareMultiLevelChartData(
  records: DataRecord[],
  filters: FilterState
): ChartDataPoint[] {
  const { yearRange, viewMode } = filters
  const [startYear, endYear] = yearRange
  
  const years: number[] = []
  for (let year = startYear; year <= endYear; year++) {
    years.push(year)
  }

  return years.map(year => {
    const dataPoint: ChartDataPoint = { year }
    
    // Group records by their display key (segment or geography)
    const displayMap = new Map<string, {
      bestRecord: DataRecord | null
      bestLevel: number
      allRecords: DataRecord[]
    }>()
    
    records.forEach(record => {
      // Determine display key based on view mode
      const displayKey = viewMode === 'segment-mode' 
        ? record.segment 
        : record.geography
      
      if (!displayMap.has(displayKey)) {
        displayMap.set(displayKey, {
          bestRecord: null,
          bestLevel: Infinity,
          allRecords: []
        })
      }
      
      const group = displayMap.get(displayKey)!
      group.allRecords.push(record)
      
      // Prefer leaf records (most granular) over aggregated records
      // If multiple records exist, use the one with the lowest aggregation level
      // (lower level = more granular = better for display)
      const recordLevel = record.aggregation_level ?? 0
      if (record.is_aggregated === false) {
        // Leaf record - always prefer this
        if (!group.bestRecord || (group.bestLevel ?? 0) > recordLevel) {
          group.bestRecord = record
          group.bestLevel = recordLevel
        }
      } else {
        // Aggregated record - only use if no leaf record exists
        if (!group.bestRecord && (group.bestLevel ?? 0) > recordLevel) {
          group.bestRecord = record
          group.bestLevel = recordLevel
        }
      }
    })
    
    // Build data point from best records
    displayMap.forEach((group, key) => {
      if (group.bestRecord) {
        dataPoint[key] = group.bestRecord.time_series[year] || 0
      } else if (group.allRecords.length > 0) {
        // Fallback: sum all records if no best record found
        const sum = group.allRecords.reduce((acc, r) => 
          acc + (r.time_series[year] || 0), 0
        )
        dataPoint[key] = sum
      }
    })
    
    return dataPoint
  })
}

/**
 * Enhanced version that allows mixing levels intelligently
 * Shows aggregated data when segments are selected at parent level,
 * Shows leaf data when segments are selected at leaf level
 * This is the recommended function for displaying multiple levels together
 */
export function prepareIntelligentMultiLevelData(
  records: DataRecord[],
  filters: FilterState & { advancedSegments?: any[] },
  byRegionRecords?: DataRecord[],
  geographyCountries?: Record<string, string[]>
): ChartDataPoint[] {
  const { yearRange, viewMode, segments, geographies } = filters
  const [startYear, endYear] = yearRange

  const years: number[] = []
  for (let year = startYear; year <= endYear; year++) {
    years.push(year)
  }

  // Get explicitly selected segments from advancedSegments
  const advancedSegments = (filters as any).advancedSegments || []
  const selectedLevel1Segments = advancedSegments
    .filter((seg: any) => seg.type === filters.segmentType)
    .map((seg: any) => seg.segment)

  // DEBUG: Log what records we received
  console.log('📊 prepareIntelligentMultiLevelData received:', {
    recordCount: records.length,
    viewMode,
    geographies,
    selectedLevel1Segments,
    recordSegments: records.map(r => r.segment),
    recordGeographies: records.map(r => r.geography),
    recordDetails: records.slice(0, 5).map(r => ({
      segment: r.segment,
      geography: r.geography,
      is_aggregated: r.is_aggregated,
      aggregation_level: r.aggregation_level,
      level_1: r.segment_hierarchy?.level_1,
      level_2: r.segment_hierarchy?.level_2
    }))
  })

  // Region to countries mapping for geography-mode
  const regionToCountries: Record<string, string[]> = {
    'North America': ['U.S.', 'Canada'],
    'Europe': ['U.K.', 'Germany', 'Italy', 'France', 'Spain', 'Russia', 'Rest of Europe'],
    'Asia Pacific': ['China', 'India', 'Japan', 'South Korea', 'ASEAN', 'Australia', 'Rest of Asia Pacific'],
    'Latin America': ['Brazil', 'Argentina', 'Mexico', 'Rest of Latin America'],
    'Middle East & Africa': ['GCC', 'South Africa', 'Rest of Middle East & Africa']
  }

  // Check if we need Global-to-geography mapping (for any non-Global geography selection)
  const hasNonGlobalSelection = geographies.some(g => g !== 'Global')
  const hasOnlyGlobalRecords = records.every(r => r.geography === 'Global')
  const needsGlobalMapping = viewMode === 'geography-mode' && hasNonGlobalSelection && hasOnlyGlobalRecords && !geographies.includes('Global')
  // Keep for backward compat
  const hasRegionalSelection = hasNonGlobalSelection

  console.log('📊 prepareIntelligentMultiLevelData Global mapping check:', {
    hasRegionalSelection,
    hasOnlyGlobalRecords,
    needsGlobalMapping,
    selectedGeographies: geographies
  })

  // Check if user explicitly selected Level 1 segments (like "By Saturation", "By Structure")
  // In this case, we want to show each selected segment as a separate series
  const hasExplicitLevel1Selection = selectedLevel1Segments.length > 0

  // Check if this is a regional segment type (By Region, By State, By Country)
  const isRegionalSegmentType = filters.segmentType === 'By Region' ||
                                filters.segmentType === 'By State' ||
                                filters.segmentType === 'By Country'

  // Group records by segment (or geography) and find the best representation
  const segmentGroups = new Map<string, DataRecord[]>()

  records.forEach(record => {
    let key: string

    // SPECIAL CASE: For regional segment types, the selected "segments" could be:
    // 1. Geography names (e.g., North America, Asia Pacific) - Level 1 selections
    // 2. Country/state names (e.g., U.S., Canada, Germany) - Level 2+ selections
    if (isRegionalSegmentType && hasExplicitLevel1Selection) {
      const regionalGeographies = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Middle East', 'Africa', 'ASEAN', 'SAARC Region', 'CIS Region', 'Global']

      // Check if selected segments are geography names or country/segment names
      const selectedAreGeographies = selectedLevel1Segments.some((seg: string) => regionalGeographies.includes(seg))
      const selectedAreSegments = selectedLevel1Segments.some((seg: string) => !regionalGeographies.includes(seg))

      if (selectedAreGeographies && !selectedAreSegments) {
        // All selections are geography names (North America, Europe, etc.)
        // Group by geography
        if (selectedLevel1Segments.includes(record.geography)) {
          key = record.geography
        } else {
          return // Skip - geography doesn't match
        }
      } else {
        // Selections include country/segment names (U.S., Canada, Germany, etc.)
        // Group by segment name
        if (selectedLevel1Segments.includes(record.segment)) {
          key = record.segment
        } else {
          return // Skip - segment doesn't match
        }
      }
    } else if (viewMode === 'segment-mode') {
      // When Level 1 segments are explicitly selected, group by the selected segment
      // This ensures each selected Level 1 segment appears as a separate series
      if (hasExplicitLevel1Selection) {
        // Check if this record matches one of the selected segments
        const matchedSegment = selectedLevel1Segments.find((seg: string) => {
          // Direct match
          if (record.segment === seg) return true
          // Hierarchy match - if this is a child record of a selected segment
          const hierarchy = record.segment_hierarchy
          return hierarchy.level_1 === seg || hierarchy.level_2 === seg
        })

        if (matchedSegment) {
          // If this is an aggregated record for a selected segment, use that segment as key
          if (record.is_aggregated && selectedLevel1Segments.includes(record.segment)) {
            key = record.segment
          } else {
            // For child records, group under their parent (the selected segment)
            key = matchedSegment
          }
        } else {
          // No match - skip this record
          return
        }
      } else {
        key = record.segment
      }
    } else if (viewMode === 'geography-mode') {
      // In geography mode, handle Global data mapping to selected regional geographies
      if (needsGlobalMapping && record.geography === 'Global') {
        // For Global records, we'll handle them separately in the year loop
        // For now, map to the first selected non-Global geography for grouping
        const selectedNonGlobal = geographies.filter(g => g !== 'Global')
        key = selectedNonGlobal[0] || record.geography
      } else {
        // Map child geographies to parent if parent is selected
        let mappedGeo = record.geography
        for (const [region, countries] of Object.entries(regionToCountries)) {
          if (countries.includes(record.geography) && geographies.includes(region)) {
            mappedGeo = region
            break
          }
        }
        key = mappedGeo
      }
    } else {
      key = record.geography
    }

    if (!segmentGroups.has(key)) {
      segmentGroups.set(key, [])
    }
    segmentGroups.get(key)!.push(record)
  })

  // DEBUG: Log the grouping keys
  console.log('📊 prepareIntelligentMultiLevelData grouping keys:', Array.from(segmentGroups.keys()))

  return years.map(year => {
    const dataPoint: ChartDataPoint = { year }

    // Special handling for geography-mode with Global data mapping
    if (needsGlobalMapping) {
      // Get ALL selected non-Global geographies (regions, countries, etc.)
      const selectedNonGlobal = geographies.filter(g => g !== 'Global')

      // Calculate total from Global records
      let globalTotal = 0
      segmentGroups.forEach((groupRecords) => {
        const leafRecord = groupRecords.find(r => !r.is_aggregated)
        if (leafRecord) {
          globalTotal += leafRecord.time_series[year] || 0
        } else {
          const bestRecord = groupRecords.reduce((best, current) => {
            if (!best) return current
            const currentLevel = current.aggregation_level ?? 0
            const bestLevel = best.aggregation_level ?? 0
            return currentLevel < bestLevel ? current : best
          }, null as DataRecord | null)
          if (bestRecord) {
            globalTotal += bestRecord.time_series[year] || 0
          }
        }
      })

      // Distribute Global data proportionally based on "By Region" market shares
      if (selectedNonGlobal.length > 0) {
        const proportions = getGeographyProportions(
          byRegionRecords || [], selectedNonGlobal, year, geographyCountries
        )
        selectedNonGlobal.forEach(geo => {
          const share = proportions.get(geo) || (1.0 / selectedNonGlobal.length)
          dataPoint[geo] = globalTotal * share
        })
      }

      return dataPoint
    }

    // Check if this is a regional segment type
    const isRegionalSegmentType = filters.segmentType === 'By Region' ||
                                  filters.segmentType === 'By State' ||
                                  filters.segmentType === 'By Country'

    // Standard logic for non-Global mapping cases
    segmentGroups.forEach((groupRecords, key) => {
      // Strategy: Use the most appropriate record for this segment
      // PRIORITY ORDER:
      // 1. If user explicitly selected Level 1 segments, prefer the aggregated record that matches
      // 2. If leaf record exists (and no explicit Level 1 selection), use it (most accurate)
      // 3. If only aggregated records exist, use the one that matches selected segments
      // 4. If multiple aggregated records, prefer the one at the level of selected segments

      // SPECIAL CASE: For regional segment types, the "key" is a geography name (North America, Asia Pacific, etc.)
      // and we should sum ALL records for that geography regardless of view mode
      const isRegionalWithSelection = isRegionalSegmentType && hasExplicitLevel1Selection

      // Check if this key is an explicitly selected Level 1 segment
      // For regional segment types, skip this check because the key is a geography, not a segment
      const isExplicitlySelectedLevel1 = !isRegionalWithSelection && hasExplicitLevel1Selection && selectedLevel1Segments.includes(key)

      if (isExplicitlySelectedLevel1) {
        // User explicitly selected this Level 1 segment
        // Find the aggregated record that matches this segment name
        const aggregatedRecord = groupRecords.find(r => r.is_aggregated && r.segment === key)

        if (aggregatedRecord) {
          // Use the aggregated record's value
          dataPoint[key] = aggregatedRecord.time_series[year] || 0
        } else {
          // No aggregated record found - sum all child records
          dataPoint[key] = groupRecords.reduce((sum, r) =>
            sum + (r.time_series[year] || 0), 0
          )
        }
      } else if (isRegionalWithSelection) {
        // SPECIAL CASE: For regional segment types with regions selected,
        // we need to SUM ALL records for this geography (e.g., sum all countries in North America)
        // because each record represents a country, and we want the total for the region
        dataPoint[key] = groupRecords.reduce((sum, r) =>
          sum + (r.time_series[year] || 0), 0
        )
      } else {
        // Standard logic for non-Level 1 selections
        const leafRecord = groupRecords.find(r => !r.is_aggregated)

        if (leafRecord) {
          // Use leaf record - most granular and accurate
          dataPoint[key] = leafRecord.time_series[year] || 0
        } else {
          // No leaf record - find best aggregated record
          // If segments are selected, prefer aggregated records that match
          let bestRecord: DataRecord | null = null

          if (segments.length > 0) {
            // Find aggregated record that matches selected segment level
            const selectedSegmentLevel = determineAggregationLevel(
              records,
              segments,
              filters.segmentType
            )

            if (selectedSegmentLevel !== null) {
              bestRecord = groupRecords.find(r =>
                r.aggregation_level === selectedSegmentLevel
              ) || null
            }
          }

          // Fallback: use the most granular aggregated record
          if (!bestRecord) {
            bestRecord = groupRecords.reduce((best, current) => {
              if (!best) return current
              // Prefer lower aggregation level (more granular)
              const currentLevel = current.aggregation_level ?? 0
              const bestLevel = best.aggregation_level ?? 0
              return currentLevel < bestLevel ? current : best
            }, null as DataRecord | null)
          }

          if (bestRecord) {
            dataPoint[key] = bestRecord.time_series[year] || 0
          } else {
            // Last resort: sum all records
            dataPoint[key] = groupRecords.reduce((sum, r) =>
              sum + (r.time_series[year] || 0), 0
          )
          }
        }
      }
    })

    return dataPoint
  })
}

/**
 * Calculate aggregated totals
 */
export function calculateTotals(
  records: DataRecord[],
  year: number
): { total: number; count: number; average: number } {
  let total = 0
  let count = 0
  
  records.forEach(record => {
    const value = record.time_series[year] || 0
    total += value
    count++
  })
  
  return {
    total,
    count,
    average: count > 0 ? total / count : 0
  }
}

/**
 * Find top performers
 */
export function findTopPerformers(
  records: DataRecord[],
  year: number,
  limit: number = 5
): Array<{ name: string; value: number }> {
  const performers = records.map(record => ({
    name: `${record.geography} - ${record.segment}`,
    value: record.time_series[year] || 0
  }))
  
  return performers
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

/**
 * Find fastest growing
 */
export function findFastestGrowing(
  records: DataRecord[],
  limit: number = 5
): Array<{ name: string; cagr: number }> {
  const growing = records.map(record => ({
    name: `${record.geography} - ${record.segment}`,
    cagr: record.cagr
  }))
  
  return growing
    .sort((a, b) => b.cagr - a.cagr)
    .slice(0, limit)
}


