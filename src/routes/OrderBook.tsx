import { Fragment, useState } from 'react'
import {
  useArticles,
  useCurrentRun,
  useOrders,
  useShipmentLines,
} from '@/data/planning'
import {
  useAddShipmentLine,
  useCreateOrder,
  useCustomers,
  useDeleteOrder,
  useDeleteShipmentLine,
} from '@/data/mutations'
import { Button, Empty, Field, Panel, Table, Tag, Td, Th } from '@/components/ui'
import { formatDateLong, formatNumber, inputClass } from '@/components/format'
import { Modal, ModalActions } from '@/components/edit'

const CONFIDENCE_TONE: Record<string, 'clear' | 'amber' | 'mid'> = {
  confirmed: 'clear',
  probable: 'amber',
  forecast: 'mid',
}

export function OrderBook() {
  const run = useCurrentRun()
  const orders = useOrders(run.data?.id)
  const deleteOrder = useDeleteOrder()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <div className="space-y-6">
      <Panel title="Order book" meta={`${orders.data?.length ?? 0} orders`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <p className="text-mid max-w-[70ch] text-[12px]">
            An order is not a single dated commitment. It ships in phases, and
            each shipment line is scheduled backwards from its own container
            stuffing date. Select an order to see its lines.
          </p>
          <Button onClick={() => setAdding(true)}>Add an order</Button>
        </div>

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
                    <td
                      colSpan={7}
                      className="bg-paper border-rule-soft border-b p-0"
                    >
                      <Lines
                        orderId={o.order_id}
                        erpOrderNo={o.erp_order_no}
                        onDeleteOrder={() => {
                          setExpanded(null)
                          deleteOrder.mutate(o.order_id)
                        }}
                      />
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

      {adding ? <AddOrder onClose={() => setAdding(false)} /> : null}
    </div>
  )
}

function Lines({
  orderId,
  erpOrderNo,
  onDeleteOrder,
}: {
  orderId: string
  erpOrderNo: string
  onDeleteOrder: () => void
}) {
  const lines = useShipmentLines(orderId)
  const deleteLine = useDeleteShipmentLine()
  const [addingLine, setAddingLine] = useState(false)

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
            <Th />
          </tr>
        </thead>
        <tbody>
          {lines.data?.map((l) => (
            <tr key={l.id}>
              <Td>{l.line_no}</Td>
              <Td align="right">{formatNumber(l.qty)}</Td>
              <Td className="font-semibold">
                {formatDateLong(l.stuffing_date)}
              </Td>
              <Td>{l.container_ref ?? '—'}</Td>
              <Td>{formatDateLong(l.material_ready_date)}</Td>
              <Td className="text-mid">{formatDateLong(l.delivery_date)}</Td>
              <Td align="right">
                <button
                  type="button"
                  className="text-faint hover:text-flag text-[11px]"
                  onClick={() => deleteLine.mutate(l.id)}
                >
                  Remove
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="quiet" onClick={() => setAddingLine(true)}>
          Add a shipment line
        </Button>
        <button
          type="button"
          className="text-faint hover:text-flag text-[11px]"
          onClick={onDeleteOrder}
        >
          Delete this order
        </button>
        <span className="text-faint text-[11px]">
          The customer delivery date is held for reference and never used in the
          arithmetic — the stuffing date is the only anchor.
        </span>
      </div>

      {addingLine ? (
        <AddShipmentLine
          orderId={orderId}
          erpOrderNo={erpOrderNo}
          onClose={() => setAddingLine(false)}
        />
      ) : null}
    </div>
  )
}

/** Fields shared by the new-order and new-line forms. */
function LineFields({
  qty,
  setQty,
  stuffingDate,
  setStuffingDate,
  containerRef,
  setContainerRef,
  materialReadyDate,
  setMaterialReadyDate,
  deliveryDate,
  setDeliveryDate,
}: {
  qty: string
  setQty: (v: string) => void
  stuffingDate: string
  setStuffingDate: (v: string) => void
  containerRef: string
  setContainerRef: (v: string) => void
  materialReadyDate: string
  setMaterialReadyDate: (v: string) => void
  deliveryDate: string
  setDeliveryDate: (v: string) => void
}) {
  return (
    <>
      <Field label="Quantity">
        <input
          className={inputClass}
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
        />
      </Field>
      <Field label="Container stuffing date">
        <input
          className={inputClass}
          type="date"
          value={stuffingDate}
          onChange={(e) => setStuffingDate(e.target.value)}
          required
        />
      </Field>
      <Field label="Container reference">
        <input
          className={inputClass}
          value={containerRef}
          onChange={(e) => setContainerRef(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <Field label="Material ready date">
        <input
          className={inputClass}
          type="date"
          value={materialReadyDate}
          onChange={(e) => setMaterialReadyDate(e.target.value)}
        />
      </Field>
      <Field label="Customer delivery date">
        <input
          className={inputClass}
          type="date"
          value={deliveryDate}
          onChange={(e) => setDeliveryDate(e.target.value)}
        />
      </Field>
    </>
  )
}

function AddOrder({ onClose }: { onClose: () => void }) {
  const customers = useCustomers()
  const articles = useArticles()
  const create = useCreateOrder()

  const [erpOrderNo, setErpOrderNo] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [articleId, setArticleId] = useState('')
  const [confidence, setConfidence] = useState('confirmed')
  const [qty, setQty] = useState('200')
  const [stuffingDate, setStuffingDate] = useState('')
  const [containerRef, setContainerRef] = useState('')
  const [materialReadyDate, setMaterialReadyDate] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')

  const chosenCustomer = customerId || customers.data?.[0]?.id || ''
  const chosenArticle = articleId || articles.data?.[0]?.id || ''

  return (
    <Modal
      title="Add an order"
      subtitle="Creates its first shipment line"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate(
            {
              erpOrderNo: erpOrderNo.trim(),
              customerId: chosenCustomer,
              articleId: chosenArticle,
              confidence,
              qty: Number(qty),
              stuffingDate,
              containerRef,
              materialReadyDate: materialReadyDate || null,
              deliveryDate: deliveryDate || null,
            },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ERP order number">
            <input
              className={inputClass}
              value={erpOrderNo}
              onChange={(e) => setErpOrderNo(e.target.value)}
              placeholder="SO/26-27/0500"
              required
            />
          </Field>
          <Field label="Customer">
            <select
              className={inputClass}
              value={chosenCustomer}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              {customers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Article">
            <select
              className={inputClass}
              value={chosenArticle}
              onChange={(e) => setArticleId(e.target.value)}
            >
              {articles.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Confidence">
            <select
              className={inputClass}
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
            >
              <option value="confirmed">Confirmed</option>
              <option value="probable">Probable</option>
              <option value="forecast">Forecast</option>
            </select>
          </Field>
          <LineFields
            qty={qty}
            setQty={setQty}
            stuffingDate={stuffingDate}
            setStuffingDate={setStuffingDate}
            containerRef={containerRef}
            setContainerRef={setContainerRef}
            materialReadyDate={materialReadyDate}
            setMaterialReadyDate={setMaterialReadyDate}
            deliveryDate={deliveryDate}
            setDeliveryDate={setDeliveryDate}
          />
        </div>

        <p className="text-mid mt-4 max-w-[65ch] text-[11.5px]">
          The ERP order number is the idempotency key for imports, so it has to
          be unique — re-importing the same file updates rather than duplicating.
        </p>

        {create.isError ? (
          <p className="text-flag mt-3 text-[11.5px]">
            {String(create.error).includes('orders_erp_order_no_key')
              ? 'That ERP order number already exists.'
              : String(create.error)}
          </p>
        ) : null}

        <ModalActions
          onCancel={onClose}
          submitLabel="Add order"
          busy={create.isPending}
        />
      </form>
    </Modal>
  )
}

function AddShipmentLine({
  orderId,
  erpOrderNo,
  onClose,
}: {
  orderId: string
  erpOrderNo: string
  onClose: () => void
}) {
  const add = useAddShipmentLine()
  const [qty, setQty] = useState('100')
  const [stuffingDate, setStuffingDate] = useState('')
  const [containerRef, setContainerRef] = useState('')
  const [materialReadyDate, setMaterialReadyDate] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')

  return (
    <Modal
      title="Add a shipment line"
      subtitle={erpOrderNo}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          add.mutate(
            {
              orderId,
              qty: Number(qty),
              stuffingDate,
              containerRef,
              materialReadyDate: materialReadyDate || null,
              deliveryDate: deliveryDate || null,
            },
            { onSuccess: onClose },
          )
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <LineFields
            qty={qty}
            setQty={setQty}
            stuffingDate={stuffingDate}
            setStuffingDate={setStuffingDate}
            containerRef={containerRef}
            setContainerRef={setContainerRef}
            materialReadyDate={materialReadyDate}
            setMaterialReadyDate={setMaterialReadyDate}
            deliveryDate={deliveryDate}
            setDeliveryDate={setDeliveryDate}
          />
        </div>
        <p className="text-mid mt-4 max-w-[65ch] text-[11.5px]">
          This phase schedules independently of the others — a separate backward
          pass from its own stuffing date.
        </p>
        <ModalActions
          onCancel={onClose}
          submitLabel="Add line"
          busy={add.isPending}
        />
      </form>
    </Modal>
  )
}
