// src/services/taskGenerator.ts
import { randomUUID } from 'crypto';
import {
  GeneratedTask,
  ProjectEstimation
} from '../models/Project';
import { TaskCategory, TaskComplexity } from '../models/taskTypes';
import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from '../config/pricing';

interface GenerateTasksInput {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
}

/**
 * Utilidad para detectar si el texto contiene alguna de varias palabras clave.
 */
function includesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * Genera un array de tareas bien definidas a partir de la descripción del proyecto.
 * Cada tarea incluye: título, descripción, categoría, prioridad, horas y precio.
 */
function buildTasksFromDescription(
  projectTitle: string,
  projectDescription: string
): GeneratedTask[] {
  const tasks: GeneratedTask[] = [];
  const base = projectDescription.slice(0, 400); // contexto

  const makeTask = (params: {
    title: string;
    description: string;
    category: TaskCategory;
    complexity: TaskComplexity;
    priority: number;
    estimatedHours: number;
  }): GeneratedTask => {
    const taskPrice = params.estimatedHours * HOURLY_RATE;

    return {
      id: randomUUID(),
      title: params.title,
      description: params.description,
      category: params.category,
      complexity: params.complexity,
      priority: params.priority,
      estimatedHours: params.estimatedHours,
      hourlyRate: HOURLY_RATE,
      taskPrice,
      // 👇 campos necesarios para tu modelo backend
      columnId: 'todo',              // siempre empieza en la columna "Por hacer"
      layer: params.category,        // alias legacy
      price: taskPrice,              // alias legacy
      developerNetPrice: taskPrice,  // si luego quieres restar comisión, lo puedes ajustar
    };
  };

  // 1. Arquitectura / análisis
  tasks.push(
    makeTask({
      title: 'Definir alcance funcional y arquitectura de la plataforma',
      description:
        `Analizar los objetivos del proyecto "${projectTitle}" y definir módulos principales ` +
        `(autenticación, IA, tablero Kanban, pagos, panel de usuario, dashboard, etc.) ` +
        `a partir de la descripción proporcionada: "${base}".`,
      category: 'ARCHITECTURE',
      complexity: 'HIGH',
      priority: 1,
      estimatedHours: 10,
    })
  );

  // 2. Modelo de datos
  tasks.push(
    makeTask({
      title: 'Diseñar modelo de datos y esquema en MongoDB',
      description:
        'Modelar colecciones para usuarios, proyectos, tareas, columnas del tablero Kanban, ' +
        'suscripciones/pagos y estadísticas (nº de proyectos, horas totales, ingresos).',
      category: 'MODEL',
      complexity: 'HIGH',
      priority: 2,
      estimatedHours: 8,
    })
  );

  // 3. Autenticación (si procede)
  if (includesAny(projectDescription, ['google', 'oauth', 'login'])) {
    tasks.push(
      makeTask({
        title: 'Implementar autenticación con Google OAuth',
        description:
          'Configurar Google OAuth en backend y frontend: endpoints de login/callback, ' +
          'validación de tokens, creación de usuarios y gestión de sesión en el panel de proyectos.',
        category: 'SERVICE',
        complexity: 'MEDIUM',
        priority: 3,
        estimatedHours: 6,
      })
    );
  }

  // 4. Servicio de generación de tareas con IA
  if (includesAny(projectDescription, ['ia', 'gpt', 'inteligencia artificial', 'modelo'])) {
    tasks.push(
      makeTask({
        title: 'Servicio de generación automática de tareas con IA',
        description:
          'Crear un servicio en el backend que reciba la descripción del proyecto, llame al modelo GPT ' +
          'y convierta la respuesta en tareas estructuradas (título, descripción, categoría, prioridad y horas estimadas).',
        category: 'SERVICE',
        complexity: 'HIGH',
        priority: 4,
        estimatedHours: 10,
      })
    );

    tasks.push(
      makeTask({
        title: 'Integrar el generador de tareas con el formulario del frontend',
        description:
          'Diseñar un formulario donde el usuario describe el proyecto y consumir el endpoint de generación. ' +
          'Mostrar las tareas resultantes en una tabla con categoría, prioridad, horas y precio.',
        category: 'VIEW',
        complexity: 'MEDIUM',
        priority: 5,
        estimatedHours: 6,
      })
    );
  }

  // 5. Verificador de tareas (QA con IA)
  if (includesAny(projectDescription, ['verificación', 'verificador', 'qa', 'calidad'])) {
    tasks.push(
      makeTask({
        title: 'Módulo de verificación de calidad de tareas con IA',
        description:
          'Crear un servicio que reciba las tareas generadas y, mediante IA, detecte ' +
          'tareas ambiguas, incompletas o duplicadas y proponga mejoras.',
        category: 'QA',
        complexity: 'HIGH',
        priority: 6,
        estimatedHours: 8,
      })
    );
  }

  // 6. Tablero tipo Kanban/Trello
  if (includesAny(projectDescription, ['kanban', 'trello', 'tablero'])) {
    tasks.push(
      makeTask({
        title: 'Diseñar e implementar tablero Kanban para proyectos',
        description:
          'Crear API y modelo para tableros con columnas (ToDo/Doing/Done), ' +
          'movimiento de tareas entre columnas y orden por prioridad.',
        category: 'SERVICE',
        complexity: 'HIGH',
        priority: 7,
        estimatedHours: 8,
      })
    );

    tasks.push(
      makeTask({
        title: 'Interfaz de tablero Kanban en el frontend',
        description:
          'Implementar un tablero visual tipo Trello donde se muestren las tareas generadas, ' +
          'permitiendo arrastrar y soltar entre columnas y ver detalles de cada tarea.',
        category: 'VIEW',
        complexity: 'MEDIUM',
        priority: 8,
        estimatedHours: 8,
      })
    );
  }

  // 7. Pagos / suscripciones con Stripe
  if (includesAny(projectDescription, ['stripe', 'suscripción', 'subscripción', 'pago'])) {
    tasks.push(
      makeTask({
        title: 'Integración de suscripción mensual con Stripe en backend',
        description:
          'Configurar Stripe Billing para planes mensuales: creación de sesión de checkout, ' +
          'webhooks para actualizar el estado de la suscripción y guardado en MongoDB.',
        category: 'SERVICE',
        complexity: 'HIGH',
        priority: 9,
        estimatedHours: 10,
      })
    );

    tasks.push(
      makeTask({
        title: 'UI de planes y estado de suscripción en el frontend',
        description:
          'Diseñar una pantalla donde el usuario vea el plan, su estado de suscripción, ' +
          'pueda suscribirse o gestionar su plan y bloquear el generador si no está activo.',
        category: 'VIEW',
        complexity: 'MEDIUM',
        priority: 10,
        estimatedHours: 6,
      })
    );
  }

  // 8. Dashboard de estadísticas
  if (includesAny(projectDescription, ['dashboard', 'estadísticas', 'métricas'])) {
    tasks.push(
      makeTask({
        title: 'Dashboard de estadísticas de proyectos y uso de la plataforma',
        description:
          'Implementar un panel que muestre número de proyectos creados, horas totales estimadas, ' +
          'ingresos y otros KPI relevantes.',
        category: 'VIEW',
        complexity: 'MEDIUM',
        priority: 11,
        estimatedHours: 8,
      })
    );
  }

  // 9. Infraestructura y despliegue
  tasks.push(
    makeTask({
      title: 'Configurar infraestructura, despliegue y CI/CD',
      description:
        'Configurar despliegue del frontend (Vercel) y backend (Render/Fly.io), variables de entorno, ' +
        'pipelines de GitHub Actions y monitorización básica.',
      category: 'INFRA',
      complexity: 'MEDIUM',
      priority: 12,
      estimatedHours: 8,
    })
  );

  // 10. QA global
  tasks.push(
    makeTask({
      title: 'Pruebas de extremo a extremo (E2E) y validación funcional',
      description:
        'Diseñar y ejecutar pruebas E2E sobre los flujos clave: login, generación de tareas, ' +
        'suscripción con Stripe, publicación en tablero y dashboard.',
      category: 'QA',
      complexity: 'MEDIUM',
      priority: 13,
      estimatedHours: 6,
    })
  );

  tasks.sort((a, b) => a.priority - b.priority);
  return tasks;
}


/**
 * Devuelve una ProjectEstimation completa:
 * - tareas + horas + precios
 * - comisión 1 %
 * - coste total
 */
export function generateProjectEstimationFromDescription(
  input: GenerateTasksInput
): ProjectEstimation {
  const { projectTitle, projectDescription, ownerEmail } = input;

  const tasks = buildTasksFromDescription(projectTitle, projectDescription);

  const totalHours = tasks.reduce((acc, t) => acc + t.estimatedHours, 0);
  const totalTasksPrice = tasks.reduce((acc, t) => acc + t.taskPrice, 0);

  const platformFeePercent = PLATFORM_FEE_PERCENT;
  const platformFeeAmount = (totalTasksPrice * platformFeePercent) / 100;
  const generatorServiceFee = 0; // el generador se paga por suscripción, no por proyecto
  const grandTotalClientCost =
    totalTasksPrice + platformFeeAmount + generatorServiceFee;

  return {
    projectTitle,
    projectDescription,
    ownerEmail,
    tasks,
    totalHours,
    totalTasksPrice,
    platformFeePercent,
    platformFeeAmount,
    generatorServiceFee,
    grandTotalClientCost,
  };
}
