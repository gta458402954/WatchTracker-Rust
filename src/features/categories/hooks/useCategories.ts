import { useState, useCallback } from 'react';
import {
  getAllCategoriesAsync,
  upsertCategory,
  renameCategory,
  deleteCategoryDb,
  reorderCategories,
} from '../../../shared/lib/database';

export interface CategoryItem {
  name: string;
  emoji: string;
  sortOrder?: number;
}

export function useCategories() {
  const [categories, setCategories] = useState<CategoryItem[]>([]);

  // 加载所有分类
  const loadCategories = useCallback(async () => {
    const allCategories = await getAllCategoriesAsync();
    setCategories(allCategories);
    return allCategories;
  }, []);

  const addCategory = useCallback((name: string, emoji: string) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (categories.some(c => c.name === trimmed)) return false; // 重复

    const newEmoji = emoji.trim() || trimmed;
    const newOrder = categories.length;
    upsertCategory(trimmed, newEmoji, newOrder);
    setCategories(prev => [...prev, { name: trimmed, emoji: newEmoji, sortOrder: newOrder }]);
    return true;
  }, [categories]);

  const updateCategory = useCallback(async (oldName: string, newName: string, newEmoji: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    if (oldName !== trimmed && categories.some(c => c.name === trimmed)) return false; // 重复

    const finalEmoji = newEmoji.trim() || trimmed;
    await renameCategory(oldName, trimmed, finalEmoji);
    setCategories(prev => prev.map(c =>
      c.name === oldName ? { name: trimmed, emoji: finalEmoji } : c
    ));
    return true;
  }, [categories]);

  const deleteCategory = useCallback((name: string) => {
    deleteCategoryDb(name);
    setCategories(prev => prev.filter(c => c.name !== name));
  }, []);

  const reorder = useCallback((names: string[]) => {
    reorderCategories(names);
    setCategories(prev => {
      const map = new Map(prev.map(c => [c.name, c]));
      return names.map(n => map.get(n)!).filter(Boolean);
    });
  }, []);

  const getEmoji = useCallback((name: string): string => {
    const cat = categories.find(c => c.name === name);
    return cat?.emoji ?? name;
  }, [categories]);

  return {
    categories,
    loadCategories,
    addCategory,
    updateCategory,
    deleteCategory,
    reorder,
    getEmoji,
    categoryNames: categories.map(c => c.name),
  };
}
