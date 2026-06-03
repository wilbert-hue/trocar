'use client'

import { useMemo } from 'react'
import { useDashboardStore } from '@/lib/store'
import { TrendingUp, DollarSign, Calendar, Activity } from 'lucide-react'
import { formatIndianNumber, formatIndianNumberWithCommas, formatCurrencyValue } from '@/lib/utils'

export function GlobalKPICards() {
  const { data, filters, currency } = useDashboardStore()

  const kpiData = useMemo(() => {
    if (!data) return null

    // Require at least one geography to display KPIs
    if (!filters.geographies || filters.geographies.length === 0) {
      return null
    }

    // Use current filters to determine what to show
    // Get target geography from filters - use all selected geographies
    const allGeographies = data.dimensions.geographies.all_geographies || []
    let selectedGeographies = filters.geographies
    
    // Get segment type from filters (or use first segment type)
    const segmentTypes = Object.keys(data.dimensions.segments)
    const targetSegmentType = filters.segmentType || segmentTypes[0] || null
    
    // If no segment type is set, can't calculate KPIs
    if (!targetSegmentType) {
      return null
    }
    
    // Get the appropriate dataset based on data type filter
    const dataset = filters.dataType === 'value'
      ? data.data.value.geography_segment_matrix
      : data.data.volume.geography_segment_matrix
    
    // Filter records based on selected geographies and segment type
    // CRITICAL: Only use leaf records (is_aggregated === false) to prevent double-counting
    // Aggregated records already contain the sum of their children, so including both would count values twice
    // ALSO CRITICAL: Filter by segment type to prevent summing across different segment types
    let globalRecords = dataset.filter(record => {
      // Filter by geography - include records from any selected geography
      if (selectedGeographies.length > 0 && !selectedGeographies.includes(record.geography)) {
        return false
      }
      // Filter by segment type (CRITICAL: prevents double-counting across segment types)
      if (targetSegmentType && record.segment_type !== targetSegmentType) {
        return false
      }
      return true
    })
    
    // Filter to only leaf records to prevent double-counting
    // Exclude aggregated records (is_aggregated === true), but allow leaf records even if aggregation_level is set
    // (aggregation_level is now set for leaf records to enable filtering by level)
    globalRecords = globalRecords.filter(record => 
      record.is_aggregated === false
    )

    // If no records match the current filters, try a fallback approach
    // Try without geography filter if geographies were selected but no records match
    if (globalRecords.length === 0 && selectedGeographies.length > 0) {
      // Try with all geographies for this segment type
      const allRecordsForSegmentType = dataset.filter(record => {
        if (targetSegmentType && record.segment_type !== targetSegmentType) {
          return false
        }
        return true
      })
      
      const leafRecords = allRecordsForSegmentType.filter(record => 
        record.is_aggregated === false
      )
      
      if (leafRecords.length > 0) {
        globalRecords = leafRecords
        // Update selected geographies to reflect that we're showing all geographies
        selectedGeographies = []
      }
    }

    // If still no records, try with just the segment type and any geography
    if (globalRecords.length === 0 && targetSegmentType) {
      const allRecordsForSegmentType = dataset.filter(record => {
        return record.segment_type === targetSegmentType
      })
      
      const leafRecords = allRecordsForSegmentType.filter(record => 
        record.is_aggregated === false
      )
      
      if (leafRecords.length > 0) {
        globalRecords = leafRecords
        selectedGeographies = []
      }
    }

    // If still no records, return null (no data available for this segment type)
    if (globalRecords.length === 0) {
      console.warn('No KPI data available for segment type:', targetSegmentType, 'with geographies:', selectedGeographies)
      return null
    }

    // Use actual years from data metadata
    const startYear = data.metadata.base_year || data.metadata.start_year
    const endYear = data.metadata.forecast_year

    // Calculate total market size for start and end years
    let marketSizeStart = 0
    let marketSizeEnd = 0

    globalRecords.forEach(record => {
      marketSizeStart += record.time_series[startYear] || 0
      marketSizeEnd += record.time_series[endYear] || 0
    })

    // Calculate CAGR from start to end year
    const years = endYear - startYear
    const cagr = marketSizeStart > 0 && years > 0
      ? (Math.pow(marketSizeEnd / marketSizeStart, 1 / years) - 1) * 100
      : 0

    // Calculate absolute growth
    const absoluteGrowth = marketSizeEnd - marketSizeStart
    const growthPercentage = marketSizeStart > 0
      ? ((marketSizeEnd - marketSizeStart) / marketSizeStart) * 100
      : 0

    // Get currency preference
    const selectedCurrency = currency || data.metadata.currency || 'USD'
    const isINR = selectedCurrency === 'INR'
    
    // Values in time_series are already in the unit specified by value_unit/volume_unit
    // For example, if value_unit is "Million", values are already in millions (e.g., 811.6 means $811.6 Million)
    // No conversion is needed - just display the values with the appropriate unit label
    const unit = filters.dataType === 'value'
      ? (data.metadata.value_unit || 'Million')
      : (data.metadata.volume_unit || 'Units')

    // Display values as-is (they're already in the correct unit)
    const marketSizeStartDisplay = marketSizeStart
    const marketSizeEndDisplay = marketSizeEnd
    const absoluteGrowthDisplay = absoluteGrowth

    // Build descriptive labels
    // Note: selectedGeographies might be empty if we fell back to showing all geographies
    const actualSelectedGeographies = filters.geographies.length > 0 ? filters.geographies : []
    const dataTypeLabel = filters.dataType === 'value' ? 'Market Size' : 'Market Volume'

    // Get market name from metadata, fallback to "Global Market"
    const marketName = data.metadata.market_name || 'Global Market'

    const geographyLabel = actualSelectedGeographies.length === 0
      ? marketName
      : actualSelectedGeographies.length === 1
      ? `${actualSelectedGeographies[0]} ${marketName}`
      : `${actualSelectedGeographies.length} Geographies ${marketName}`
    const segmentTypeLabel = targetSegmentType || 'All Segments'

    return {
      marketSizeStart: marketSizeStartDisplay,
      marketSizeEnd: marketSizeEndDisplay,
      startYear,
      endYear,
      cagr,
      absoluteGrowth: absoluteGrowthDisplay,
      growthPercentage,
      currency: selectedCurrency,
      unit: isINR ? '' : (unit || 'Million'),
      dataTypeLabel,
      geographyLabel,
      segmentTypeLabel,
      dataType: filters.dataType,
      isINR
    }
  }, [data, filters, currency])

  if (!kpiData) return null

  return (
    <div className="bg-gradient-to-r from-gray-50 to-gray-100 border-y border-gray-200">
      <div className="container mx-auto px-6 py-3">
        {/* Descriptive Header */}
        <div className="mb-3 pb-2 border-b border-gray-300">
          <p className="text-xs text-gray-700">
            <span className="font-semibold">{kpiData.dataTypeLabel}</span>
            {' for '}
            <span className="font-semibold">{kpiData.geographyLabel}</span>
            {kpiData.segmentTypeLabel && (
              <>
                {' | '}
                <span className="font-semibold">{kpiData.segmentTypeLabel}</span>
              </>
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
          {/* Market Size - Start Year */}
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-100 rounded">
              {kpiData.currency === 'INR' ? (
                <span className="text-blue-600 font-bold text-lg">₹</span>
              ) : (
                <DollarSign className="h-4 w-4 text-blue-600" />
              )}
            </div>
            <div>
              <p className="text-[10px] text-black uppercase tracking-wider font-semibold">
                {kpiData.dataTypeLabel} {kpiData.startYear}
              </p>
              <p className="text-base font-bold text-black leading-tight">
                {kpiData.dataType === 'value' && kpiData.isINR
                  ? `₹ ${formatIndianNumber(kpiData.marketSizeStart)}`
                  : kpiData.dataType === 'value'
                  ? `$ ${kpiData.marketSizeStart.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`
                  : `${kpiData.marketSizeStart.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`}
              </p>
            </div>
          </div>

          {/* Market Size - End Year */}
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-green-100 rounded">
              <Calendar className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <p className="text-[10px] text-black uppercase tracking-wider font-semibold">
                {kpiData.dataTypeLabel} {kpiData.endYear}
              </p>
              <p className="text-base font-bold text-black leading-tight">
                {kpiData.dataType === 'value' && kpiData.isINR
                  ? `₹ ${formatIndianNumber(kpiData.marketSizeEnd)}`
                  : kpiData.dataType === 'value'
                  ? `$ ${kpiData.marketSizeEnd.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`
                  : `${kpiData.marketSizeEnd.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`}
              </p>
            </div>
          </div>

          {/* CAGR */}
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-purple-100 rounded">
              <TrendingUp className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <p className="text-[10px] text-black uppercase tracking-wider font-semibold">
                CAGR ({kpiData.startYear}-{kpiData.endYear})
              </p>
              <p className="text-base font-bold text-black leading-tight">
                {kpiData.cagr.toFixed(2)}%
              </p>
            </div>
          </div>

          {/* Absolute Growth */}
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-100 rounded">
              <Activity className="h-4 w-4 text-orange-600" />
            </div>
            <div>
              <p className="text-[10px] text-black uppercase tracking-wider font-semibold">
                Absolute Growth ({kpiData.startYear}-{kpiData.endYear})
              </p>
              <p className="text-base font-bold text-black leading-tight">
                {kpiData.dataType === 'value' && kpiData.isINR
                  ? `₹ ${formatIndianNumber(kpiData.absoluteGrowth)}`
                  : kpiData.dataType === 'value'
                  ? `$ ${kpiData.absoluteGrowth.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`
                  : `${kpiData.absoluteGrowth.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${kpiData.unit}`}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">
                +{kpiData.growthPercentage.toFixed(1)}% increase
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
