import { useEffect, useState } from 'react';
import { settingsApi } from '../services/api';
import { Settings, Save, Database, Shield, AlertCircle, CheckCircle, Trash2, Key, RefreshCcw, Eye, EyeOff } from 'lucide-react';

interface AIModel {
  id: string;
  name: string;
  provider: string;
  description: string;
}

interface ProviderConfig {
  api_key: string;
  enabled: boolean;
  thinking_mode: boolean;
}

interface AISettings {
  provider: string;
  model_id: string;
  configs: Record<string, ProviderConfig>;
  max_ai_concurrency: number;
}

const AiScanningEnginePage = ({ userId }: { userId: string | null }) => {
  const [models, setModels] = useState<AIModel[]>([]);
  const [settings, setSettings] = useState<AISettings>({
    provider: 'gemini',
    model_id: 'gemini-3-flash-preview',
    configs: {
      gemini: { api_key: '', enabled: true, thinking_mode: false },
      deepseek: { api_key: '', enabled: true, thinking_mode: false }
    },
    max_ai_concurrency: 4,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const activeConfig = settings.configs[settings.provider] || { api_key: '', enabled: true, thinking_mode: false };
  const isKeyConfigured = activeConfig.api_key?.startsWith('********');
  const activeModel = models.find(m => m.id === settings.model_id);
  const supportsThinking = activeModel?.supports_thinking ?? false;

  useEffect(() => {
    if (!userId) return;

    const fetchData = async () => {
      try {
        const [modelsData, settingsData] = await Promise.all([
          settingsApi.getAvailableModels(),
          settingsApi.getAISettings()
        ]);
        setModels(modelsData);
        // Ensure structure is initialized
        const mergedConfigs = {
          gemini: { api_key: '', enabled: true },
          deepseek: { api_key: '', enabled: true },
          ...settingsData.configs
        };
        setSettings({ ...settingsData, configs: mergedConfigs });
      } catch (error) {
        console.error('Failed to fetch AI settings:', error);
        setMessage({ type: 'error', text: 'Failed to load settings. Please try again.' });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [userId]);

  const updateActiveConfig = (updates: Partial<ProviderConfig>) => {
    setSettings(prev => ({
      ...prev,
      configs: {
        ...prev.configs,
        [prev.provider]: { ...prev.configs[prev.provider], ...updates }
      }
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await settingsApi.updateAISettings({
        provider: settings.provider,
        model_id: settings.model_id,
        api_key: activeConfig.api_key,
        enabled: activeConfig.enabled,
        thinking_mode: activeConfig.thinking_mode,
        max_ai_concurrency: settings.max_ai_concurrency,
      });
      // Re-map updated back to structure
      setSettings(prev => ({ ...prev, ...updated }));
      setMessage({ type: 'success', text: 'Settings saved successfully!' });
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: 'Failed to save settings. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!activeConfig.api_key) return;
    setTesting(true);
    setShowTestModal(false);
    setMessage(null);
    try {
      const result = await settingsApi.testAISettings({
        api_key: activeConfig.api_key,
        model_id: settings.model_id,
        provider: settings.provider
      });
      if (result.success) {
        setMessage({ type: 'success', text: result.message });
      } else {
        setMessage({ type: 'error', text: result.message });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleDeleteKey = async () => {
    setSaving(true);
    setShowDeleteModal(false);
    try {
      const updated = await settingsApi.updateAISettings({
        provider: settings.provider,
        api_key: "",
        enabled: true
      });
      setSettings(prev => ({ ...prev, ...updated }));
      setMessage({ type: 'success', text: 'API Key removed successfully' });
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to remove API key' });
    } finally {
      setSaving(false);
    }
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-8">
        <Settings className="h-8 w-8 text-blue-600" />
        <h1 className="text-3xl font-bold text-gray-900">AI Scanning Engine</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Left Column: Settings Form */}
        <div className="md:col-span-2 space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Shield className="h-5 w-5 text-blue-500" />
                Model Selection
              </h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                  <select 
                    value={settings.provider}
                    onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="deepseek">DeepSeek</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                  <select 
                    value={settings.model_id}
                    onChange={(e) => setSettings({ ...settings, model_id: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                  >
                    {models.filter(m => m.provider === settings.provider).map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-sm text-gray-500">
                    {models.find(m => m.id === settings.model_id)?.description}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 bg-gray-50 border-t border-gray-200">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <Database className="h-5 w-5 text-blue-500" />
                  API Key Configuration
                </h2>
                {isKeyConfigured && (
                  <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" />
                    ALREADY SETUP
                  </span>
                )}
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id="useCustomKey"
                    checked={activeConfig.enabled}
                    onChange={(e) => updateActiveConfig({ enabled: e.target.checked })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="useCustomKey" className="text-sm font-medium text-gray-700">
                    Use my own API key
                  </label>
                </div>

                {supportsThinking && (
                  <div className="flex items-center gap-2 p-4 bg-purple-50 rounded-lg border border-purple-100">
                    <input 
                      type="checkbox" 
                      id="thinkingMode"
                      checked={activeConfig.thinking_mode}
                      onChange={(e) => updateActiveConfig({ thinking_mode: e.target.checked })}
                      className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded"
                    />
                    <label htmlFor="thinkingMode" className="text-sm font-medium text-purple-900">
                      Enable Thinking Mode
                    </label>
                  </div>
                )}

                {activeConfig.enabled ? (
                  <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-3">
                    <div className="flex justify-between items-end">
                      <label className="block text-sm font-medium text-gray-700">Custom API Key</label>
                      {isKeyConfigured && (
                        <button 
                          onClick={() => setShowDeleteModal(true)}
                          className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1 font-medium"
                        >
                          <Trash2 className="h-3.3 w-3.5" />
                          Change or Remove
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input 
                        type={showKey ? "text" : "password"}
                        value={activeConfig.api_key}
                        onChange={(e) => updateActiveConfig({ api_key: e.target.value })}
                        placeholder={isKeyConfigured ? "Key is saved and active" : "Paste your API key here"}
                        className="w-full pl-10 pr-12 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono text-sm"
                      />
                      <Key className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
                      >
                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={() => setShowTestModal(true)}
                        disabled={!activeConfig.api_key || testing}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 transition-all"
                      >
                        {testing ? <RefreshCcw className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                        {testing ? 'Testing...' : 'Test Connection'}
                      </button>
                      
                      {isKeyConfigured && !activeConfig.api_key.startsWith('********') && (
                        <p className="text-xs text-amber-600 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Don't forget to Save your changes!
                        </p>
                      )}
                    </div>

                    <p className="text-xs text-gray-500 flex items-start gap-2 bg-blue-50/50 p-3 rounded-lg border border-blue-100/50">
                      <AlertCircle className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                      Your key is stored securely. We mask it after saving for your privacy.
                    </p>
                  </div>
                ) : (
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-100 text-blue-700 text-sm">
                    Using default shared API key. This is currently free but may be restricted in the future.
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving || testing}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-300 transition-colors shadow-sm"
              >
                {saving ? (
                  <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></span>
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>

          {/* Batch Concurrency */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Settings className="h-5 w-5 text-blue-500" />
                Batch Speed
              </h2>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Parallel AI calls during batch scanning
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { value: 1, label: '1×', desc: 'Serial — slow', tier: 'free' },
                    { value: 2, label: '2×', desc: 'Free tier', tier: 'free' },
                    { value: 4, label: '4×', desc: 'Recommended', tier: 'paid' },
                    { value: 8, label: '8×', desc: 'Pro tier', tier: 'paid' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setSettings(s => ({ ...s, max_ai_concurrency: opt.value }))}
                      className={`p-3 rounded-lg border text-center transition-colors ${
                        settings.max_ai_concurrency === opt.value
                          ? 'border-blue-400 bg-blue-50 text-blue-700'
                          : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                      }`}
                    >
                      <div className="text-lg font-bold">{opt.label}</div>
                      <div className="text-[10px] text-gray-400">{opt.desc}</div>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  How many image chunks the AI processes at once.
                  <span className="text-amber-600 font-medium"> Stick to 1–2 on the free Gemini tier</span>
                  {' '}to avoid rate limits. Paid tiers can use 4–8 for ~3–8× faster batch results.
                </p>
              </div>
            </div>
          </div>

          {message && (
            <div className={`p-4 rounded-lg flex items-center gap-3 animate-in fade-in zoom-in duration-200 ${
              message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
            }`}>
              {message.type === 'success' ? <CheckCircle className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
              {message.text}
            </div>
          )}
        </div>

        {/* Right Column: Info/Help */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
            <h3 className="font-bold text-gray-900 mb-3">How it works</h3>
            <ul className="text-sm text-gray-600 space-y-3 list-disc pl-4">
              <li>Choose between different AI models depending on your needs.</li>
              <li><b>Flash</b> models are faster and cheaper.</li>
              <li><b>Pro</b> models are more accurate but slower.</li>
              <li>Using your own API key removes any rate limits imposed by the default key.</li>
            </ul>
          </div>

          <div className="bg-indigo-50 p-6 rounded-xl shadow-sm border border-indigo-100">
            <h3 className="font-bold text-indigo-900 mb-2">Support for more models</h3>
            <p className="text-sm text-indigo-700">
              We are working on adding support for GPT-4 (OpenAI) and Claude 3 (Anthropic) to give you more choices for receipt extraction accuracy.
            </p>
          </div>
        </div>
      </div>

      {/* Test Connection Modal */}
      {showTestModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-amber-600 mb-4">
              <AlertCircle className="h-6 w-6" />
              <h3 className="text-xl font-bold">Test API Connection?</h3>
            </div>
            <p className="text-gray-600 mb-6">
              This will make a single small API call to Google Gemini to verify your key. 
              This uses a tiny amount of your API quota (if applicable).
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowTestModal(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
              <button 
                onClick={handleTest}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
              >
                Agree & Test
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Management Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-red-600 mb-4">
              <Trash2 className="h-6 w-6" />
              <h3 className="text-xl font-bold">Manage API Key</h3>
            </div>
            <p className="text-gray-600 mb-6">
              What would you like to do with your saved Gemini API key?
            </p>
            <div className="space-y-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSettings({
                    ...settings,
                    configs: {
                      ...settings.configs,
                      [settings.provider]: {
                        ...settings.configs[settings.provider],
                        api_key: ''
                      }
                    }
                  });
                }}
                className="w-full px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 flex items-center justify-center gap-2"
              >
                <RefreshCcw className="h-4 w-4" />
                Change to a new key
              </button>
              <button 
                onClick={handleDeleteKey}
                className="w-full px-4 py-3 bg-red-50 border border-red-100 text-red-600 rounded-lg font-medium hover:bg-red-100 flex items-center justify-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Delete key completely
              </button>
              <button 
                onClick={() => setShowDeleteModal(false)}
                className="w-full px-4 py-2 text-gray-500 font-medium hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AiScanningEnginePage;
