import { useMemo, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const OMR_API_TOKEN = import.meta.env.VITE_OMR_API_TOKEN || ''

export default function App() {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [questions, setQuestions] = useState(50)
  const [optionsPerQuestion, setOptionsPerQuestion] = useState(4)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const entries = useMemo(() => Object.entries(result?.answers || {}), [result])

  const onFile = (next) => {
    if (!next) return
    setFile(next)
    setResult(null)
    setError('')
    setPreview(URL.createObjectURL(next))
  }

  const upload = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    const form = new FormData()
    form.append('image', file)
    form.append('questions', String(questions))
    form.append('options_per_question', String(optionsPerQuestion))

    try {
      const res = await fetch(`${API_BASE}/upload-omr`, {
        method: 'POST',
        headers: OMR_API_TOKEN ? { Authorization: `Bearer ${OMR_API_TOKEN}` } : undefined,
        body: form,
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.detail || 'Failed')
      setResult(payload)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <h1 className="text-3xl font-bold text-slate-900">Production OMR Detector</h1>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="rounded-xl border bg-white p-4 shadow-sm">
            <span className="text-sm text-slate-500">Questions</span>
            <input type="number" className="mt-2 w-full rounded-md border p-2" value={questions} onChange={(e) => setQuestions(Number(e.target.value || 50))} />
          </label>
          <label className="rounded-xl border bg-white p-4 shadow-sm">
            <span className="text-sm text-slate-500">Options per Question</span>
            <input type="number" className="mt-2 w-full rounded-md border p-2" value={optionsPerQuestion} onChange={(e) => setOptionsPerQuestion(Number(e.target.value || 4))} />
          </label>
          <button onClick={upload} disabled={!file || loading} className="rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white disabled:opacity-60">
            {loading ? 'Processing...' : 'Submit OMR'}
          </button>
        </div>

        <div
          onDrop={(e) => {
            e.preventDefault()
            onFile(e.dataTransfer.files?.[0])
          }}
          onDragOver={(e) => e.preventDefault()}
          className="rounded-2xl border-2 border-dashed border-indigo-300 bg-white p-6 text-center"
        >
          <p className="mb-3 text-slate-600">Drag & drop OMR image here, or choose file</p>
          <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} className="mx-auto block" />
        </div>

        {preview && (
          <div className="rounded-xl border bg-white p-3 shadow-sm">
            <h2 className="mb-2 font-semibold">Input Preview</h2>
            <img src={preview} alt="preview" className="max-h-[420px] w-full rounded-lg object-contain" />
          </div>
        )}

        {error && <div className="rounded-md bg-red-50 p-3 text-red-700">{error}</div>}

        {result && (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <h3 className="font-semibold text-slate-900">Detected Answers</h3>
              <p className="mt-1 text-sm text-slate-600">Confidence: {result.confidence_score}</p>
              <p className="text-sm text-slate-600">Processing: {result.processing_time_ms} ms</p>
              {result.warnings?.length > 0 && (
                <ul className="mt-3 list-disc pl-5 text-amber-700">
                  {result.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              <div className="mt-4 max-h-[420px] overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr><th className="p-2 text-left">Q</th><th className="p-2 text-left">Ans</th></tr>
                  </thead>
                  <tbody>
                    {entries.map(([q, ans]) => (
                      <tr key={q} className={ans === 'INVALID' ? 'bg-red-50' : ''}>
                        <td className="border-t p-2">{q}</td>
                        <td className="border-t p-2 font-semibold">{ans}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <h3 className="mb-2 font-semibold text-slate-900">Visual Detection Overlay</h3>
              {result.debug_overlay_base64 ? (
                <img
                  src={`data:image/jpeg;base64,${result.debug_overlay_base64}`}
                  alt="overlay"
                  className="max-h-[520px] w-full rounded-lg object-contain"
                />
              ) : (
                <p className="text-sm text-slate-500">No overlay generated.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
