// src/services/storage.ts
import { storage } from './firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

export const uploadImageToStorage = async (userId: string, file: File) => {
  try {
    const storageRef = ref(storage, `receipts/${userId}/${file.name}`);
    await uploadBytes(storageRef, file);
    return await getDownloadURL(storageRef);
  } catch (error) {
    console.error('Failed to upload image to storage:', error);
    throw new Error('Failed to upload image. Please try again.');
  }
};