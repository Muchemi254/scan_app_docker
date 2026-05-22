// src/services/firestore.ts
import { db } from './firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export const saveReceipt = async (userId: string, data: any) => {
  try {
    const receiptsRef = collection(db, `users/${userId}/receipts`);
    return await addDoc(receiptsRef, {
      ...data,
      timestamp: serverTimestamp()
    });
  } catch (error) {
    console.error('Failed to save receipt to Firestore:', error);
    throw new Error('Unable to save receipt. Please check your internet connection.');
  }
};