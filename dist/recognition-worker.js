import { suggestCalibration } from './recognition.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: suggestCalibration(data.imageData, data.seed) }); }
  catch { self.postMessage({ error: 'recognition' }); }
};
