import { Fragment, useState } from 'react'
import { useCurrentRun, useOrders, useShipmentLines } from '@/data/planning'
import { Empty, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber } from '@/components/format'

const CONFIDENCE_TONE: Record<string, 'clear' | 'amber' | 'mid'> = {
  confirmed: 'clear',
  probable: 'amber',
  forecast: 'mid',
}

export function OrderBook() {
  const run = useCurrentRun()
  const orders = useOrders(run.data?.id)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <Panel title="Order book" meta={`${orders.data?.length ?? 0} orders`}>
        <p className="text-mid mb-4 max-w-[80ch] text-[12px]">
          An order is not a single dated commitment. It ships in phases, and each
          shipment line is scheduled backwards from its own container stuffing
          date. Select an order to see its lines.
        </p>

        <Table>
          <thead>
            <tr>
              <Th>ERP order</Th>
              <Th>Customer</Th>
              <Th>Article</Th>
              <Th align="right">Quantity</Th>
              <Th align="right">Lines</Th>
              <Th>First stuffing</Th>
              <Th>Confidence</Th>
              <Th align="right">Breaches</Th>
            </tr>
          </thead>
          <tbody>
            {orders.data?.map((o) => (
              <Fragment key={o.order_id}>
                <tr
                  onClick={() =>
                    setExpanded(expanded === o.order_id ? null : o.order_id)
                  }
                  className="hover:bg-paper cursor-pointer"
                >
                  <Td className="font-semibold">{o.erp_order_no}</Td>
                  <Td>{o.customer_name}</Td>
                  <Td>{o.article_code}</Td>
                  <Td align="right">{formatNumber(o.total_qty)}</Td>
                  <Td align="right">
                    {o.line_count}
                    {o.unallocated_qty !== 0 ? (
                      <span
                        className="text-amber ml-1"
                        title={`${formatNumber(o.unallocated_qty)} units not yet on a shipment line`}
                      >
                        !
                      </span>
                    ) : null}
                  </Td>
                  <Td>{formatDateLong(o.next_stuffing)}</Td>
                  <Td>
                    <Tag tone={CONFIDENCE_TONE[o.confidence] ?? 'mid'}>
                      {o.confidence}
                    </Tag>
                  </Td>
                  <Td align="right">
                    {o.breaches ? (
                      <span className="text-flag font-semibold">
                        {o.breaches}
                      </span>
                    ) : (
                      <span className="text-clear">—</span>
                    )}
                  </Td>
                </tr>
                {expanded === o.order_id ? (
                  <tr>
                    <Td className="bg-paper">{null}</Td>
                    <td colSpan={7} className="bg-paper border-rule-soft border-b p-0">
                      <Lines orderId={o.order_id} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>

        {!orders.data?.length ? <Empty>No orders yet.</Empty> : null}

        <p className="text-faint mt-4 text-[11.5px]">
          An exclamation beside the line count means the shipment lines do not
          add up to the order total — a warning, not an error, since the first of
          three phases is a legitimate thing to have entered.
        </p>
      </Panel>
    </div>
  )
}

function Lines({ orderId }: { orderId: string }) {
  const lines = useShipmentLines(orderId)
  return (
    <div className="px-4 py-3">
      <Table>
        <thead>
          <tr>
            <Th>Line</Th>
            <Th align="right">Quantity</Th>
            <Th>Stuffing</Th>
            <Th>Container</Th>
            <Th>Material ready</Th>
            <Th>Customer delivery</Th>
          </tr>
        </thead>
        <tbody>
          {lines.data?.map((l) => (
            <tr key={l.id}>
              <Td>{l.line_no}</Td>
              <Td align="right">{formatNumber(l.qty)}</Td>
              <Td className="font-semibold">{formatDateLong(l.stuffing_date)}</Td>
              <Td>{l.container_ref ?? '—'}</Td>
              <Td>{formatDateLong(l.material_ready_date)}</Td>
              <Td className="text-mid">{formatDateLong(l.delivery_date)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-faint mt-2 text-[11px]">
        The customer delivery date is held for reference and never used in the
        arithmetic — the stuffing date is the only anchor.
      </p>
    </div>
  )
}
