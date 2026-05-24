import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { receiptApi, taskApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import { useTaskStore } from '../stores/taskStore';
import { useTaskProgress } from '../hooks/useTaskProgress';

const ScannerPageEnhanced = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const { invalidate } = useReceiptStore();
  const taskProgress = useTaskProgress({
    onProgressUpdate: (progress) => {
      console.log(`Progress: ${progress}%`);
    },
    onTaskComplete: () => {
      console.log('Task completed!');
      invalidate(); // batch is done — force fresh load on next page visit
      setTimeout(() => navigate('/receipts'), 2000);
    },
    onTaskError: (error) => {
      console.error('Task error:', error);
    }
  });

  const [batchTitle, setBatchTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [resumeData, setResumeData] = useState<any>(null);

  /**
   * Check for incomplete tasks on mount
   */
  useEffect(() => {
    const checkForIncompleteTask = async () => {
      if (!userId) return;
      // Use Zustand store's persisted state instead of IndexedDB
      const storeState = useTaskStore.getState();
      if (storeState.activeTaskId && storeState.isProcessing) {
        setResumeData({
          taskId: storeState.activeTaskId,
          batchTitle: storeState.batchTitle,
          totalItems: storeState.totalFiles,
          completedItems: storeState.currentIndex + 1,
        });
        setShowResumeDialog(true);
      }
    };
    checkForIncompleteTask();
  }, [userId]);

  /**
   * Handle file selection
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      setSelectedFiles(files);
      setError('');
    }
  };

  /**
   * Check for missing fields
   */
  const isMissing = (val: any) =>
    val === undefined || val === null || val === 'N/A' || val === '' || (typeof val === 'string' && val.trim() === '');

  const hasMissingFields = (data: any): boolean => {
    const requiredFields = ['supplier', 'receiptDate', 'totalAmount', 'taxAmount', 'category', 'invoiceNumber', 'kraPin', 'cuInvoice'];
    for (const key of requiredFields) {
      if (isMissing(data[key])) return true;
    }

    const items = data.items;
    if (!Array.isArray(items) || items.length === 0) return true;

    for (const item of items) {
      if (
        isMissing(item.name) ||
        isMissing(item.quantity) ||
        isMissing(item.price) ||
        (!item.isZeroRated && isMissing(item.tax))
      ) {
        return true;
      }
    }

    return false;
  };

  /**
   * Resume incomplete task
   */
  const handleResumeTask = async () => {
    if (!resumeData) return;

    try {
      setBatchTitle(resumeData.batchTitle);
      taskProgress.initializeTask([], resumeData.batchTitle);

      // Skip to current index
      taskProgress.updateProgress(resumeData.completedItems - 1, resumeData.totalItems);

      setShowResumeDialog(false);

      // Optionally notify backend that task is resuming
      if (taskProgress.activeTaskId) {
        await taskApi.resumeTask(resumeData.taskId);
      }
    } catch (err) {
      setError('Failed to resume task');
      console.error(err);
    }
  };

  /**
   * Start new task
   */
  const handleStartNewTask = () => {
    setResumeData(null);
    setShowResumeDialog(false);
  };

  /**
   * Process images
   */
  const processImages = async () => {
    if (!userId || selectedFiles.length === 0 || !batchTitle?.trim()) {
      setError('Please select images and enter a batch title');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (selectedFiles.length === 1) {
        // --- Sync Path (Single File) ---
        const image = selectedFiles[0];
        const extractedData = await receiptApi.extract(image);
        await receiptApi.create(
          {
            ...extractedData,
            batchTitle: batchTitle.trim(),
            status: 'needs_review',
          },
          image
        );
        navigate('/receipts');
      } else {
        // --- Async Path (Batch) ---
        // Initialize task
        const taskId = taskProgress.initializeTask(selectedFiles, batchTitle);

        // Upload batch to backend
        const taskResponse = await receiptApi.batchExtract(selectedFiles);
        const backendTaskId = taskResponse.task_id;
        
        // Store backend task ID for polling
        useTaskStore.getState().setBackendTaskId(backendTaskId);
        
        console.log(`Async task started: ${backendTaskId}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Processing failed';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Retry single file
   */
  const retryFile = async (index: number) => {
    const file = selectedFiles[index];
    if (!file) return;

    taskProgress.updateFileStatus(index, 'processing', 'Retrying...');
    
    try {
      // Extract data
      const extractedData = await receiptApi.extract(file);
      await receiptApi.create(
        {
          ...extractedData,
          batchTitle: batchTitle.trim(),
          status: 'needs_review',
        },
        file
      );

      taskProgress.updateFileStatus(
        index,
        hasMissing ? 'needs_review' : 'done',
        hasMissing ? 'Saved for review' : 'Processed successfully'
      );
    } catch (err) {
      taskProgress.updateFileStatus(
        index,
        'failed',
        err instanceof Error ? err.message : 'Failed again'
      );
    }
  };

  /**
   * Retry all failed files as a new batch
   */
  const retryAllFailed = async () => {
    const failedFiles = taskProgress.files
      .map((f, i) => f.status === 'failed' ? selectedFiles[i] : null)
      .filter((f): f is File => f !== null);

    if (failedFiles.length === 0) return;

    // Trigger the same batch processing flow for only the failed files
    // Since batch processing is now async via /batch-extract, we can just reuse that.
    try {
        setLoading(true);
        // Initialize new sub-task or just append to existing
        await receiptApi.batchExtract(failedFiles);
        // Note: Task tracking updates might need a different UI approach
        // for "retry" batches, but this sends them to the worker correctly.
        setError('');
    } catch (err) {
        setError('Failed to batch retry');
    } finally {
        setLoading(false);
    }
  };

  /**
   * Format time
   */
  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  return (
    <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-3xl mx-auto mt-4 sm:mt-8">
      {/* Resume Dialog */}
      {showResumeDialog && resumeData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-lg max-w-sm">
            <h3 className="text-lg font-semibold mb-4">Resume Incomplete Task?</h3>
            <p className="mb-4 text-sm text-gray-600">
              Found an incomplete task: <strong>{resumeData.batchTitle}</strong>
            </p>
            <p className="mb-4 text-sm text-gray-600">
              Progress: {resumeData.completedItems} of {resumeData.totalItems} items
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleResumeTask}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Resume
              </button>
              <button
                onClick={handleStartNewTask}
                className="flex-1 px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400"
              >
                Start New
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-semibold text-gray-800">📄 Scan Receipts</h2>
        {taskProgress.isProcessing && (
          <button
            onClick={() => taskProgress.pauseTask()}
            className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600"
          >
            Pause
          </button>
        )}
      </div>

      {/* Batch Title */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          🏷️ Batch Title
        </label>
        <input
          type="text"
          value={batchTitle}
          onChange={(e) => setBatchTitle(e.target.value)}
          placeholder="e.g. June Market Run"
          className="w-full px-4 py-2 border rounded disabled:opacity-50"
          disabled={loading || taskProgress.isProcessing}
        />
      </div>

      {/* File Input */}
      {!taskProgress.isProcessing && (
        <input
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileChange}
          disabled={loading}
          className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 mb-4"
        />
      )}

      {/* Progress Bar */}
      {taskProgress.isProcessing && (
        <div className="mb-6">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium">Progress</span>
            <span className="text-sm font-medium">{taskProgress.currentProgress}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${taskProgress.currentProgress}%` }}
            />
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-600">
            <span>
              {taskProgress.currentIndex + 1} / {taskProgress.totalFiles}
            </span>
            <span>
              Elapsed: {formatTime(taskProgress.elapsedTime)}
            </span>
            <span>
              Est. remaining: {formatTime(taskProgress.estimatedTimeRemaining)}
            </span>
          </div>
        </div>
      )}

      {/* Process Button */}
      <button
        onClick={processImages}
        disabled={loading || !userId || selectedFiles.length === 0 || !batchTitle?.trim()}
        className={`w-full py-2 px-4 rounded-md text-white font-medium transition ${
          loading || !userId || selectedFiles.length === 0 || !batchTitle?.trim()
            ? 'bg-indigo-300 cursor-not-allowed'
            : 'bg-indigo-600 hover:bg-indigo-700'
        }`}
      >
        {loading ? 'Processing...' : '📤 Process Images'}
      </button>

      {/* Error Message */}
      {error && <p className="text-red-600 text-sm mt-4">{error}</p>}

      {/* File Status List */}
      {taskProgress.files.length > 0 && (
        <div className="mt-6 space-y-2">
          <div className="flex justify-between items-center">
            <h3 className="font-medium text-gray-700">Processing Status</h3>
            {taskProgress.files.some(f => f.status === 'failed') && (
              <button 
                onClick={retryAllFailed}
                className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
              >
                🔄 Retry All Failed
              </button>
            )}
          </div>
          {taskProgress.files.map((file, i) => (
            <div
              key={i}
              className="text-sm flex justify-between items-center border p-2 rounded bg-gray-50"
            >
              <span className="truncate flex-1 mr-2">{file.name}</span>
              <span
                className={`whitespace-nowrap flex items-center gap-2 ${
                  file.status === 'done'
                    ? 'text-green-600'
                    : file.status === 'needs_review'
                    ? 'text-yellow-600'
                    : file.status === 'failed'
                    ? 'text-red-600'
                    : file.status === 'processing'
                    ? 'text-blue-600'
                    : 'text-gray-600'
                }`}
              >
                {file.status === 'processing' && (
                  <div className="animate-spin h-3 w-3 border border-blue-600 border-t-transparent rounded-full mr-1" />
                )}
                {file.status === 'done' && '✅'}
                {file.status === 'needs_review' && '⚠️'}
                {file.status === 'failed' && (
                  <button 
                    onClick={() => retryFile(i)}
                    className="flex items-center gap-1 hover:underline text-xs"
                  >
                    🔄 Retry
                  </button>
                )}
                {file.status === 'failed' && '❌'}
                {file.status === 'pending' && '⏳'}
                {file.message && ` ${file.message}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ScannerPageEnhanced;
