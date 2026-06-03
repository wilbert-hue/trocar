'use client'

import { useMemo, useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'
import { CHART_THEME, getChartColor, CHART_COLORS } from '@/lib/chart-theme'
import { filterData, prepareGroupedBarData, prepareIntelligentMultiLevelData, getUniqueGeographies, getUniqueSegments, getGeographyProportions } from '@/lib/data-processor'
import { useDashboardStore } from '@/lib/store'
import type { DataRecord } from '@/lib/types'

interface GroupedBarChartProps {
  title?: string
  height?: number
}

export function GroupedBarChart({ title, height = 400 }: GroupedBarChartProps) {
  const { data, filters, currency } = useDashboardStore()
  const [hoveredBar, setHoveredBar] = useState<string | null>(null)

  const chartData = useMemo(() => {
    if (!data) return { data: [], series: [], stackedSeries: null }

    // Get the appropriate dataset
    const dataset = filters.dataType === 'value'
      ? data.data.value.geography_segment_matrix
      : data.data.volume.geography_segment_matrix

    // IMPORTANT: Determine effective aggregation level BEFORE filtering
    // This ensures filterData uses the correct logic based on user's segment selection
    const advancedSegments = filters.advancedSegments || []
    const segmentsFromSameType = advancedSegments.filter(
      (seg: any) => seg.type === filters.segmentType
    )
    const hasUserSelectedSegments = segmentsFromSameType.length > 0

    // Determine effective aggregation level for BOTH filtering and chart preparation
    // When user selects a parent segment (like "Parenteral"), we want to show its children
    // (Intravenous, Intramuscular, Subcutaneous) as separate bars, NOT aggregate them
    let effectiveAggregationLevel: number | null = filters.aggregationLevel ?? null

    // CRITICAL: When user has explicitly selected segments, ALWAYS use null
    // This prevents any Level 2 aggregation and shows individual sub-segments
    if (hasUserSelectedSegments) {
      // User selected segments - show individual records (children of selected parents)
      effectiveAggregationLevel = null
    } else if (effectiveAggregationLevel === null) {
      // No segments selected - use Level 2 to show parent segments aggregated
      effectiveAggregationLevel = 2
    }

    console.log('📊 Chart Data Debug:', {
      totalDataset: dataset.length,
      hasUserSelectedSegments,
      effectiveAggregationLevel,
      segmentsFromSameType: segmentsFromSameType.map((s: any) => s.segment),
      advancedSegments: advancedSegments.map((s: any) => ({ type: s.type, segment: s.segment })),
      filtersSegmentType: filters.segmentType,
      filtersAggregationLevel: filters.aggregationLevel,
      willCallFunction: effectiveAggregationLevel !== null ? 'prepareGroupedBarData' : 'prepareIntelligentMultiLevelData'
    })

    // Create modified filters with the effective aggregation level
    // This ensures filterData uses our computed level, not the raw filter value
    const modifiedFilters = {
      ...filters,
      aggregationLevel: effectiveAggregationLevel
    }

    // Filter data with the correct effective aggregation level
    let filtered = filterData(dataset, modifiedFilters)

    // If showLevel1Totals is enabled in geography mode, also include Level 1 aggregated records
    if (filters.viewMode === 'geography-mode' && filters.showLevel1Totals && filters.geographies.length > 0) {
      const level1Records = dataset.filter(record =>
        record.aggregation_level === 1 &&
        record.segment_type === filters.segmentType &&
        (filters.geographies.length === 0 || filters.geographies.includes(record.geography))
      )

      // Merge level 1 records with filtered data, avoiding duplicates
      const existingKeys = new Set(filtered.map(r => `${r.geography}::${r.segment}::${r.segment_type}`))
      const newLevel1Records = level1Records.filter(r =>
        !existingKeys.has(`${r.geography}::${r.segment}::${r.segment_type}`)
      )
      filtered = [...filtered, ...newLevel1Records]
    }

    // Get unique segment names from filtered data
    const allSegmentNames = [...new Set(filtered.map(r => r.segment))]

    console.log('📊 After filtering:', {
      filteredCount: filtered.length,
      effectiveAggregationLevel,
      allSegmentNames,
      hasUserSelectedSegments,
      selectedSegments: segmentsFromSameType.map((s: any) => s.segment),
      sampleFiltered: filtered.slice(0, 10).map(r => ({
        segment: r.segment,
        is_aggregated: r.is_aggregated,
        aggregation_level: r.aggregation_level,
        level_1: r.segment_hierarchy?.level_1,
        level_2: r.segment_hierarchy?.level_2
      }))
    })

    // CRITICAL: Verify that when user selected a parent segment, we got the child records
    // If we only have the parent segment in filtered data, something went wrong in filtering
    if (hasUserSelectedSegments && segmentsFromSameType.length === 1) {
      const selectedSegment = segmentsFromSameType[0].segment
      // Check if filtered data contains the selected segment directly (bad) or its children (good)
      const hasParentInData = allSegmentNames.includes(selectedSegment)
      const hasOnlyParent = hasParentInData && allSegmentNames.length === 1

      if (hasOnlyParent) {
        console.warn('⚠️ WARNING: Selected parent segment but only got parent in filtered data. Expected children!')
        console.warn('This indicates filterData is not correctly finding child records via hierarchy matching.')
      }
    }

    // Extract "By Region" records for proportional geography distribution
    const byRegionRecords = dataset.filter(r => r.segment_type === 'By Region')
    const geographyCountries = data.dimensions.geographies.countries

    // Prepare chart data
    // Use prepareGroupedBarData when we have an effective aggregation level (handles Level 2 aggregation)
    // This ensures parent segments are shown instead of sub-segments when no segment is selected
    const prepared = effectiveAggregationLevel !== null
      ? prepareGroupedBarData(filtered, modifiedFilters, byRegionRecords, geographyCountries)
      : prepareIntelligentMultiLevelData(filtered, modifiedFilters, byRegionRecords, geographyCountries)

    // Extract all keys from prepared data
    const allPreparedKeys = new Set<string>()
    prepared.forEach(dp => {
      Object.keys(dp).forEach(k => {
        if (k !== 'year') allPreparedKeys.add(k)
      })
    })

    console.log('📊 Prepared chart data:', {
      preparedLength: prepared.length,
      preparedKeys: [...allPreparedKeys],
      samplePrepared: prepared.slice(0, 2),
      effectiveAggregationLevel,
      hasUserSelectedSegments,
      advancedSegments: filters.advancedSegments,
      usingFunction: effectiveAggregationLevel !== null ? 'prepareGroupedBarData' : 'prepareIntelligentMultiLevelData'
    })

    // Check if prepared data uses stacked keys (contains "::")
    const hasStackedKeys = [...allPreparedKeys].some(k => (k as string).includes('::'))

    // Determine if we're using stacked bars
    // Override: Don't stack if prepared data doesn't have stacked keys (e.g., Level 2 aggregation with Global fallback)
    let isStacked = (filters.viewMode === 'segment-mode' && filters.geographies.length > 1) ||
                      (filters.viewMode === 'geography-mode' && filters.segments.length > 1)

    // If all filtered records have the same geography (Global fallback) in segment mode,
    // disable stacking since we can't differentiate by geography
    if (isStacked && filters.viewMode === 'segment-mode') {
      const uniqueRecordGeos = new Set(filtered.map(r => r.geography))
      if (uniqueRecordGeos.size <= 1 && !hasStackedKeys) {
        isStacked = false
      }
    }

    let series: string[] = []
    let stackedSeries: { primary: string[], secondary: string[] } | null = null

    // Extract series from prepared data keys instead of from filtered records
    // This ensures we use the aggregated keys (e.g., "Parenteral") not the original segment names (e.g., "Intravenous")
    const extractSeriesFromPreparedData = (): string[] => {
      if (prepared.length === 0) return []

      // Get all unique keys from prepared data (excluding 'year')
      const allKeys = new Set<string>()
      prepared.forEach(dataPoint => {
        Object.keys(dataPoint).forEach(key => {
          if (key !== 'year') {
            allKeys.add(key)
          }
        })
      })

      return Array.from(allKeys)
    }

    if (isStacked) {
      // For stacked bars, we need to identify primary and secondary dimensions
      if (filters.viewMode === 'segment-mode') {
        // Primary: segments (bar groups), Secondary: geographies (stacks)
        const uniqueSegments = getUniqueSegments(filtered)
        const hasOnlyGlobalRecordsSeg = filtered.every(r => r.geography === 'Global')
        // Use selected geographies when Global data is distributed to non-Global geographies
        const uniqueGeographies = (hasOnlyGlobalRecordsSeg && !filters.geographies.includes('Global'))
          ? filters.geographies.filter(g => g !== 'Global')
          : getUniqueGeographies(filtered)

        stackedSeries = {
          primary: uniqueSegments,
          secondary: uniqueGeographies
        }

        // Create series for each segment::geography combination
        series = []
        uniqueSegments.forEach(segment => {
          uniqueGeographies.forEach(geo => {
            series.push(`${segment}::${geo}`)
          })
        })
      } else if (filters.viewMode === 'geography-mode') {
        // Primary: geographies (bar groups), Secondary: segments (stacks)
        // Use selected geographies instead of record geographies when Global data is used as fallback
        const hasOnlyGlobalRecords = filtered.every(r => r.geography === 'Global')

        // If user selected non-Global geographies but we only have Global records, use selected geographies
        const uniqueGeographies = (hasOnlyGlobalRecords && !filters.geographies.includes('Global'))
          ? filters.geographies
          : getUniqueGeographies(filtered)
        const uniqueSegments = getUniqueSegments(filtered)

        stackedSeries = {
          primary: uniqueGeographies,
          secondary: uniqueSegments
        }

        // Create series for each geography::segment combination
        series = []
        uniqueGeographies.forEach(geo => {
          uniqueSegments.forEach(segment => {
            series.push(`${geo}::${segment}`)
          })
        })
      }
    } else {
      // Non-stacked: Get series from prepared data to ensure we use aggregated keys
      // FIRST: Check for regional segment types - these need special handling regardless of view mode
      const isRegionalSegmentType = filters.segmentType === 'By Region' ||
                                    filters.segmentType === 'By State' ||
                                    filters.segmentType === 'By Country'

      if (isRegionalSegmentType && advancedSegments.length > 0) {
        // For regional segment types, the selected "segments" are actually geography names
        // Use them directly as the series
        const selectedRegions = advancedSegments
          .filter((seg: any) => seg.type === filters.segmentType)
          .map((seg: any) => seg.segment)

        if (selectedRegions.length > 0) {
          series = selectedRegions
        } else {
          series = getUniqueGeographies(filtered)
        }
      } else if (effectiveAggregationLevel === 1) {
        // Level 1 shows total aggregation - group by geography
        series = getUniqueGeographies(filtered)
      } else if (filters.viewMode === 'segment-mode') {
        // For segment mode with Level 2 aggregation, extract keys from prepared data
        series = extractSeriesFromPreparedData()
      } else {
        // Geography mode - use selected geographies when Global data is used as fallback
        const hasNonGlobalSelection = filters.geographies.some(g => g !== 'Global')
        const hasOnlyGlobalRecordsGeo = filtered.every(r => r.geography === 'Global')

        series = (hasNonGlobalSelection && hasOnlyGlobalRecordsGeo && !filters.geographies.includes('Global'))
          ? filters.geographies.filter(g => g !== 'Global')
          : extractSeriesFromPreparedData()
      }
    }

    console.log('📊 Series:', series)
    console.log('📊 Stacked Series:', stackedSeries)

    // Debug for Level 1
    if (filters.aggregationLevel === 1) {
      console.log('📊 Level 1 Chart Debug:', {
        filteredCount: filtered.length,
        filteredRecords: filtered.slice(0, 3).map(r => ({
          geo: r.geography,
          segment: r.segment,
          level: r.aggregation_level
        })),
        preparedData: prepared.slice(0, 2),
        series: series,
        seriesLength: series.length
      })
    }

    return { data: prepared, series, stackedSeries, isStacked }
  }, [data, filters])

  if (!data || chartData.data.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
        <div className="text-center">
          <p className="text-black">No data to display</p>
          <p className="text-sm text-black mt-1">
            Try adjusting your filters
          </p>
        </div>
      </div>
    )
  }

  const selectedCurrency = currency || data.metadata.currency || 'USD'
  const isINR = selectedCurrency === 'INR'
  const currencySymbol = isINR ? '₹' : '$'
  const unitLabel = isINR ? '' : (data.metadata.value_unit || 'Million')
  
  const yAxisLabel = filters.dataType === 'value'
    ? isINR 
      ? `Market Value (${currencySymbol})`
      : `Market Value (${selectedCurrency} ${unitLabel})`
    : `Market Volume (${data.metadata.volume_unit})`

  // Matrix view should use heatmap instead
  if (filters.viewMode === 'matrix') {
    return (
      <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
        <div className="text-center">
          <p className="text-black text-lg font-medium">Matrix View Active</p>
          <p className="text-sm text-black mt-2">
            Please switch to the Heatmap tab to see the matrix visualization
          </p>
          <p className="text-xs text-black mt-1">
            Bar charts work best with Segment Mode or Geography Mode
          </p>
        </div>
      </div>
    )
  }

  // Custom tooltip for stacked bars
  const CustomTooltip = ({ active, payload, label, coordinate }: any) => {
    if (!active || !payload || !payload.length) return null

    const year = label
    const selectedCurrency = currency || data.metadata.currency || 'USD'
    const isINR = selectedCurrency === 'INR'
    const currencySymbol = isINR ? '₹' : '$'
    const unitText = isINR ? '' : (data.metadata.value_unit || 'Million')
    
    const unit = filters.dataType === 'value'
      ? isINR 
        ? currencySymbol
        : `${selectedCurrency} ${unitText}`
      : data.metadata.volume_unit

    if (chartData.isStacked) {
      // Use the hoveredBar state to determine which stack to show
      if (!hoveredBar) return null
      
      // Filter payload to only include entries for the hovered bar
      const relevantPayload = payload.filter((entry: any) => {
        const [primary] = entry.dataKey.split('::')
        return primary === hoveredBar && entry.value > 0
      })
      
      if (relevantPayload.length === 0) {
        return null
      }
      
      const hoveredStackId = hoveredBar
      
      // Build the breakdown for only the hovered bar
      const items: Array<{name: string, value: number, color: string}> = []
      relevantPayload.forEach((entry: any) => {
        const [, secondary] = entry.dataKey.split('::')
        if (secondary && entry.value > 0) {
          items.push({
            name: secondary,
            value: entry.value,
            color: entry.color
          })
        }
      })
      
      const total = items.reduce((sum, item) => sum + item.value, 0)

      return (
        <div className="bg-white p-4 border border-gray-200 rounded-lg shadow-lg min-w-[250px] max-w-[350px]">
          <p className="font-semibold text-black mb-2 pb-2 border-b border-gray-200">
            Year: <span className="text-blue-600">{year}</span>
          </p>
          <div className="mb-2">
            <div className="font-semibold text-black mb-2">{hoveredStackId}</div>
            {items.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between gap-4 ml-4 mb-1">
                <div className="flex items-center gap-2">
                  <div 
                    className="w-2 h-2 rounded" 
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-sm text-black">{item.name}</span>
                </div>
                <span className="text-sm font-medium text-black">
                  {item.value.toLocaleString(undefined, { 
                    minimumFractionDigits: 2, 
                    maximumFractionDigits: 2 
                  })} {unit}
                </span>
              </div>
            ))}
            {items.length > 1 && (
              <div className="flex items-center justify-between gap-4 mt-2 pt-2 border-t border-gray-100">
                <span className="text-sm font-semibold text-black ml-4">Total</span>
                <span className="text-sm font-bold text-black">
                  {total.toLocaleString(undefined, { 
                    minimumFractionDigits: 2, 
                    maximumFractionDigits: 2 
                  })} {unit}
                </span>
              </div>
            )}
          </div>
          <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-black">
            {filters.viewMode === 'segment-mode' 
              ? `Showing ${hoveredStackId} across ${items.length} geographies`
              : `Showing ${hoveredStackId} across ${items.length} segments`
            }
          </div>
        </div>
      )
    }

    // Non-stacked tooltip (original)
    return (
      <div className="bg-white p-4 border border-gray-200 rounded-lg shadow-lg min-w-[250px]">
        <p className="font-semibold text-black mb-3 pb-2 border-b border-gray-200">
          Year: <span className="text-blue-600">{year}</span>
        </p>
        <div className="space-y-2">
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded" 
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-sm font-medium text-black">
                  {entry.name}
                </span>
              </div>
              <div className="text-right">
                <span className="text-sm font-semibold text-black">
                  {entry.value.toLocaleString(undefined, { 
                    minimumFractionDigits: 2, 
                    maximumFractionDigits: 2 
                  })}
                </span>
                <span className="text-xs text-black ml-1">
                  {unit}
                </span>
              </div>
            </div>
          ))}
        </div>
        {/* Add total for geography mode */}
        {filters.viewMode === 'geography-mode' && payload.length > 0 && (
          <div className="mt-3 pt-2 border-t border-gray-200">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-semibold text-black">Total</span>
              <span className="text-sm font-bold text-black">
                {payload.reduce((sum: number, entry: any) => sum + (entry.value || 0), 0).toLocaleString(undefined, { 
                  minimumFractionDigits: 2, 
                  maximumFractionDigits: 2 
                })} {unit}
              </span>
            </div>
          </div>
        )}
        <div className="mt-3 pt-2 border-t border-gray-200 text-xs text-black">
          {filters.viewMode === 'segment-mode' 
            ? 'Comparing segments across selected geographies'
            : 'Comparing geographies for selected segments'
          }
        </div>
      </div>
    )
  }

  return (
    <div className="w-full">
      {title && (
        <h3 className="text-lg font-semibold mb-4 text-black">{title}</h3>
      )}
      
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={chartData.data}
          margin={{ top: 20, right: 30, left: 80, bottom: 20 }}
        >
          <CartesianGrid {...CHART_THEME.grid} />
          <XAxis
            dataKey="year"
            tick={{ fontSize: 12 }}
            label={{ value: 'Year', position: 'insideBottom', offset: -5 }}
          />
          <YAxis
            tick={{ fontSize: 12 }}
            width={70}
            label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', style: { textAnchor: 'middle' }, dx: -10 }}
          />
          <Tooltip 
            content={<CustomTooltip />} 
            trigger="hover"
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 1000 }}
          />
          <Legend 
            {...CHART_THEME.legend}
            content={(props) => {
              const { payload } = props
              if (!payload || !chartData.isStacked || !chartData.stackedSeries) {
                // Default legend for non-stacked
                return (
                  <ul className="flex flex-wrap justify-center gap-4 mt-4">
                    {payload?.map((entry: any, index: number) => (
                      <li key={`item-${index}`} className="flex items-center gap-2">
                        <span 
                          className="inline-block w-3 h-3 rounded"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-sm text-black">{entry.value}</span>
                      </li>
                    ))}
                  </ul>
                )
              }

              // Custom legend for stacked bars - show only primary dimension
              const uniquePrimary = new Set<string>()
              const legendItems: Array<{name: string, color: string}> = []
              
              payload.forEach((entry: any) => {
                const [primary] = entry.value.split('::')
                if (!uniquePrimary.has(primary)) {
                  uniquePrimary.add(primary)
                  legendItems.push({
                    name: primary,
                    color: entry.color
                  })
                }
              })
                        
                        return (
                <ul className="flex flex-wrap justify-center gap-4 mt-4">
                  {legendItems.map((item, index) => (
                    <li key={`item-${index}`} className="flex items-center gap-2">
                      <span 
                        className="inline-block w-3 h-3 rounded"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-sm text-black">{item.name}</span>
                    </li>
                  ))}
                </ul>
              )
            }}
          />
          
          {chartData.isStacked && chartData.stackedSeries ? (
            // Render stacked bars
            chartData.stackedSeries.primary.map((primary, primaryIdx) => {
              // Get all series for this primary dimension
              const primarySeries = chartData.series.filter(s => s.startsWith(`${primary}::`))
              
              return primarySeries.map((seriesName, secondaryIdx) => {
                const [, secondary] = seriesName.split('::')
                return (
                  <Bar
                    key={seriesName}
                    dataKey={seriesName}
                    stackId={primary}
                    fill={getChartColor(primaryIdx, secondaryIdx)}
                    name={seriesName}
                    onMouseEnter={() => setHoveredBar(primary)}
                    onMouseLeave={() => setHoveredBar(null)}
                  />
                )
              })
            }).flat()
          ) : (
            // Render non-stacked bars
            chartData.series.map((seriesName, index) => (
            <Bar
              key={seriesName}
              dataKey={seriesName}
              fill={getChartColor(index)}
              name={seriesName}
            />
            ))
          )}
        </BarChart>
      </ResponsiveContainer>

      {chartData.series.length > 0 && (
        <div className="mt-4 text-sm text-black text-center">
          {chartData.isStacked ? (
            <>
              Comparing {chartData.stackedSeries?.primary.length} {filters.viewMode === 'segment-mode' ? 'segments' : 'geographies'}
              {' '}with {chartData.stackedSeries?.secondary.length} {filters.viewMode === 'segment-mode' ? 'geography' : 'segment'} breakdown
            </>
          ) : (
            <>
        Comparing {chartData.series.length} {filters.viewMode === 'segment-mode' ? 'segments' : 'geographies'} 
            </>
          )}
        {' '}from {filters.yearRange[0]} to {filters.yearRange[1]}
        </div>
      )}
    </div>
  )
}